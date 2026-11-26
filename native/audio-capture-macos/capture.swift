import CoreAudio
import Foundation

let frameMagic: UInt32 = 0x55424431
let frameVersion: UInt16 = 1
let maxPayloadBytes: UInt32 = 1_048_576
let formatTagFloat32LE: UInt16 = 1

let kindFormat: UInt16 = 0
let kindAudio: UInt16 = 1
let kindEnd: UInt16 = 2

let endCompleted: UInt16 = 0
let endCancelled: UInt16 = 1

struct Options {
  var runMs: UInt64 = 0
  var syntheticFrames: UInt64 = 0
  var chunkFrames: UInt32 = 2048
}

func parseOptions(_ args: [String]) -> Options? {
  var out = Options()
  var i = 1
  while i < args.count {
    let flag = args[i]
    func takeNumber() -> UInt64? {
      guard i + 1 < args.count, let value = UInt64(args[i + 1]) else { return nil }
      i += 2
      return value
    }
    switch flag {
    case "--run-ms":
      guard let value = takeNumber(), value <= 3_600_000 else { return nil }
      out.runMs = value
    case "--synthetic-frames":
      guard let value = takeNumber(), value <= 100_000 else { return nil }
      out.syntheticFrames = value
    case "--chunk-frames":
      guard let value = takeNumber(), value >= 256, value <= 8192 else { return nil }
      out.chunkFrames = UInt32(value)
    default:
      return nil
    }
  }
  return out
}

func emitDiagnostic(_ fields: [(String, String)]) {
  var parts = [String]()
  for (key, value) in fields {
    parts.append("\"\(key)\":\(value)")
  }
  let line = "{\(parts.joined(separator: ","))}\n"
  FileHandle.standardError.write(Data(line.utf8))
}

func emitState(_ state: String, attempt: UInt64, extra: [(String, String)] = []) {
  emitDiagnostic([("state", "\"\(state)\""), ("attempt", "\(attempt)")] + extra)
}

func writeBytes(_ data: Data) -> Bool {
  do {
    try FileHandle.standardOutput.write(contentsOf: data)
    return true
  } catch {
    return false
  }
}

func appendLE<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
  var little = value.littleEndian
  withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
}

func writeFrame(kind: UInt16, seq: UInt64, payload: Data) -> Bool {
  if payload.count > Int(maxPayloadBytes) { return false }
  var header = Data()
  header.reserveCapacity(20)
  appendLE(frameMagic, to: &header)
  appendLE(kind, to: &header)
  appendLE(frameVersion, to: &header)
  appendLE(seq, to: &header)
  appendLE(UInt32(payload.count), to: &header)
  return writeBytes(header) && (payload.isEmpty || writeBytes(payload))
}

func formatPayload(sampleRate: UInt32, channels: UInt16) -> Data {
  var payload = Data()
  appendLE(sampleRate, to: &payload)
  appendLE(channels, to: &payload)
  appendLE(formatTagFloat32LE, to: &payload)
  return payload
}

func audioPayload(startSample: UInt64, samples: [Float32], count: Int) -> Data {
  var payload = Data()
  payload.reserveCapacity(8 + count * 4)
  appendLE(startSample, to: &payload)
  samples.withUnsafeBytes { payload.append(contentsOf: $0.prefix(count * 4)) }
  return payload
}

func endPayload(captured: UInt64, delivered: UInt64, dropped: UInt64, reason: UInt16) -> Data {
  var payload = Data()
  appendLE(captured, to: &payload)
  appendLE(delivered, to: &payload)
  appendLE(dropped, to: &payload)
  appendLE(reason, to: &payload)
  return payload
}

final class FrameRing: @unchecked Sendable {
  private let lock = NSLock()
  private var slots: [[Float32]]
  private var filled: [Int]
  private var head = 0
  private var tail = 0
  private var count = 0
  var dropped: UInt64 = 0

  init(slotCount: Int, slotSamples: Int) {
    slots = Array(repeating: Array(repeating: 0, count: slotSamples), count: slotCount)
    filled = Array(repeating: 0, count: slotCount)
  }

  var capacity: Int { slots.count }

  func push(_ source: UnsafePointer<Float32>, sampleCount: Int) {
    lock.lock()
    defer { lock.unlock() }
    if count == slots.count {
      dropped += 1
      return
    }
    let slot = tail
    slots[slot].withUnsafeMutableBufferPointer { dest in
      dest.baseAddress?.update(from: source, count: min(sampleCount, dest.count))
    }
    filled[slot] = min(sampleCount, slots[slot].count)
    tail = (tail + 1) % slots.count
    count += 1
  }

  func pop(into dest: inout [Float32]) -> Int {
    lock.lock()
    defer { lock.unlock() }
    if count == 0 { return 0 }
    let slot = head
    let n = filled[slot]
    dest.withUnsafeMutableBufferPointer { out in
      out.baseAddress?.update(from: slots[slot], count: min(n, out.count))
    }
    head = (head + 1) % slots.count
    count -= 1
    return n
  }

  func snapshotDropped() -> UInt64 {
    lock.lock()
    defer { lock.unlock() }
    return dropped
  }
}

var terminationRequested = false

func requestTermination(_: Int32) {
  terminationRequested = true
}

func getString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
  var addr = AudioObjectPropertyAddress(
    mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var result: CFTypeRef?
  var size = UInt32(MemoryLayout<CFTypeRef?>.size)
  guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &result) == noErr,
    let str = result as? String
  else { return nil }
  return str
}

func getTapFormat(_ tapID: AudioObjectID) -> AudioStreamBasicDescription? {
  var addr = AudioObjectPropertyAddress(
    mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var asbd = AudioStreamBasicDescription()
  var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
  guard AudioObjectGetPropertyData(tapID, &addr, 0, nil, &size, &asbd) == noErr else { return nil }
  return asbd
}

final class RealCapture {
  let options: Options
  var tapID = AudioObjectID(0)
  var aggID = AudioObjectID(0)
  var procID: AudioDeviceIOProcID?
  var ring: FrameRing?
  var capturedChunks: UInt64 = 0
  var deliveredSamples: UInt64 = 0
  var channels: UInt32 = 0
  var signalReported = false

  init(options: Options) {
    self.options = options
  }

  func acquire(format: inout AudioStreamBasicDescription) -> Bool {
    let sysObj = AudioObjectID(kAudioObjectSystemObject)
    var outDevice = AudioObjectID(0)
    var outSize = UInt32(MemoryLayout<AudioObjectID>.size)
    var outAddr = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    guard AudioObjectGetPropertyData(sysObj, &outAddr, 0, nil, &outSize, &outDevice) == noErr else {
      emitState("error", attempt: 0, extra: [("stage", "\"default-output\"")])
      return false
    }
    guard let outUID = getString(outDevice, kAudioDevicePropertyDeviceUID) else {
      emitState("error", attempt: 0, extra: [("stage", "\"output-uid\"")])
      return false
    }
    let desc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
    guard AudioHardwareCreateProcessTap(desc, &tapID) == noErr, tapID != 0 else {
      emitState("error", attempt: 0, extra: [("stage", "\"create-tap\"")])
      return false
    }
    guard let tapUID = getString(tapID, kAudioTapPropertyUID) else {
      emitState("error", attempt: 0, extra: [("stage", "\"tap-uid\"")])
      destroyTap()
      return false
    }
    guard let tapFormat = getTapFormat(tapID) else {
      emitState("error", attempt: 0, extra: [("stage", "\"tap-format\"")])
      destroyTap()
      return false
    }
    let isFloat = (tapFormat.mFormatFlags & kAudioFormatFlagIsFloat) != 0
    let interleaved = (tapFormat.mFormatFlags & kAudioFormatFlagIsNonInterleaved) == 0
    guard isFloat, interleaved, tapFormat.mBitsPerChannel == 32 else {
      emitState("error", attempt: 0, extra: [("stage", "\"unsupported-format\"")])
      destroyTap()
      return false
    }
    format = tapFormat
    channels = tapFormat.mChannelsPerFrame
    let comp: [String: Any] = [
      kAudioAggregateDeviceNameKey: "UrbuddyAudioCapture",
      kAudioAggregateDeviceUIDKey: "tools.urbuddy.audio-capture.tap",
      kAudioAggregateDeviceMainSubDeviceKey: outUID,
      kAudioAggregateDeviceSubDeviceListKey: [outUID],
      kAudioAggregateDeviceIsPrivateKey: true,
    ]
    guard AudioHardwareCreateAggregateDevice(comp as CFDictionary, &aggID) == noErr, aggID != 0
    else {
      emitState("error", attempt: 0, extra: [("stage", "\"create-aggregate\"")])
      destroyTap()
      return false
    }
    var tapProp = AudioObjectPropertyAddress(
      mSelector: kAudioAggregateDevicePropertyTapList, mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    var listSize: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(aggID, &tapProp, 0, nil, &listSize) == noErr else {
      emitState("error", attempt: 0, extra: [("stage", "\"taplist-size\"")])
      teardown()
      return false
    }
    var current: CFTypeRef?
    var csize = listSize
    guard AudioObjectGetPropertyData(aggID, &tapProp, 0, nil, &csize, &current) == noErr else {
      emitState("error", attempt: 0, extra: [("stage", "\"taplist-get\"")])
      teardown()
      return false
    }
    var taps = (current as? [String]) ?? []
    if !taps.contains(tapUID) { taps.append(tapUID) }
    let cfList = taps as CFArray
    var mList: CFArray? = cfList
    let setSize = UInt32(MemoryLayout<CFArray>.size)
    let setStatus = withUnsafeMutablePointer(to: &mList) { ptr in
      AudioObjectSetPropertyData(aggID, &tapProp, 0, nil, setSize, ptr)
    }
    guard setStatus == noErr else {
      emitState("error", attempt: 0, extra: [("stage", "\"taplist-set\"")])
      teardown()
      return false
    }
    let slotSamples = Int(options.chunkFrames) * Int(channels)
    ring = FrameRing(slotCount: 64, slotSamples: slotSamples)
    var created: AudioDeviceIOProcID?
    let createStatus = AudioDeviceCreateIOProcIDWithBlock(&created, aggID, nil) {
      _, inInputData, _, _, _ in
      let abl = inInputData.pointee
      if !self.signalReported {
        self.signalReported = true
        var sizes = [String]()
        withUnsafePointer(to: abl) { ptr in
          for b in 0..<Int(abl.mNumberBuffers) {
            let buf = UnsafeRawPointer(ptr).advanced(by: MemoryLayout<AudioBufferList>.size + b * MemoryLayout<AudioBuffer>.size)
              .assumingMemoryBound(to: AudioBuffer.self).pointee
            sizes.append("\(buf.mDataByteSize)")
          }
        }
        emitState("signal", attempt: 1, extra: [
          ("buffers", "\(abl.mNumberBuffers)"), ("bytes", "\"\(sizes.joined(separator: ","))\""),
        ])
      }
      guard abl.mNumberBuffers == 1 else { return }
      let buf: AudioBuffer = withUnsafePointer(to: abl) { ptr in
        UnsafeRawPointer(ptr).advanced(by: MemoryLayout<AudioBufferList>.size)
          .assumingMemoryBound(to: AudioBuffer.self).pointee
      }
      guard let data = buf.mData else { return }
      let floats = data.assumingMemoryBound(to: Float32.self)
      let count = Int(buf.mDataByteSize) / 4
      self.ring?.push(floats, sampleCount: count)
      self.capturedChunks += 1
    }
    guard createStatus == noErr, let created else {
      emitState("error", attempt: 0, extra: [("stage", "\"create-ioproc\"")])
      teardown()
      return false
    }
    procID = created
    return true
  }

  func start(attempt: UInt64) -> Bool {
    guard let procID else { return false }
    for _ in 0..<3 {
      if AudioDeviceStart(aggID, procID) == noErr {
        return true
      }
      Thread.sleep(forTimeInterval: 0.2)
    }
    emitState("error", attempt: attempt, extra: [("stage", "\"start\"")])
    return false
  }

  func destroyTap() {
    if tapID != 0 {
      AudioHardwareDestroyProcessTap(tapID)
      tapID = 0
    }
  }

  func teardown() {
    if let procID, aggID != 0 {
      AudioDeviceStop(aggID, procID)
      AudioDeviceDestroyIOProcID(aggID, procID)
      self.procID = nil
    }
    if aggID != 0 {
      AudioHardwareDestroyAggregateDevice(aggID)
      aggID = 0
    }
    destroyTap()
  }

  func run() -> Int32 {
    var format = AudioStreamBasicDescription()
    guard acquire(format: &format) else { return 3 }
    guard start(attempt: 1) else {
      teardown()
      return 3
    }
    let sampleRate = UInt32(format.mSampleRate)
    let channelCount = UInt16(format.mChannelsPerFrame)
    emitState("ready", attempt: 1)
    guard writeFrame(kind: kindFormat, seq: 0, payload: formatPayload(sampleRate: sampleRate, channels: channelCount)) else {
      teardown()
      return 3
    }
    let chunkSamples = Int(options.chunkFrames) * Int(channelCount)
    var scratch = [Float32](repeating: 0, count: chunkSamples)
    var seq: UInt64 = 1
    var deliveredFrames: UInt64 = 0
    let deadline = options.runMs == 0 ? nil as Date? : Date(timeIntervalSinceNow: Double(options.runMs) / 1000.0)
    var reason = endCompleted
    while true {
      if terminationRequested {
        reason = endCancelled
        break
      }
      if let deadline, Date() >= deadline { break }
      let n = ring?.pop(into: &scratch) ?? 0
      if n == 0 {
        Thread.sleep(forTimeInterval: 0.002)
        continue
      }
      let samplesPerChannel = n / Int(channelCount)
      let ok = writeFrame(
        kind: kindAudio, seq: seq,
        payload: audioPayload(startSample: deliveredSamples / UInt64(channelCount), samples: scratch, count: n))
      deliveredSamples += UInt64(n)
      deliveredFrames += 1
      seq += 1
      if !ok { break }
      if samplesPerChannel == 0 { break }
    }
    let dropped = ring?.snapshotDropped() ?? 0
    _ = writeFrame(
      kind: kindEnd, seq: seq,
      payload: endPayload(
        captured: capturedChunks, delivered: deliveredFrames, dropped: dropped, reason: reason))
    teardown()
    emitState("end", attempt: 1, extra: [
      ("captured", "\(capturedChunks)"), ("delivered", "\(deliveredFrames)"),
      ("dropped", "\(dropped)"), ("cancelled", reason == endCancelled ? "true" : "false"),
    ])
    return 0
  }
}

func runSynthetic(options: Options) -> Int32 {
  let sampleRate: UInt32 = 48_000
  let channelCount: UInt16 = 2
  let chunkSamples = Int(options.chunkFrames) * Int(channelCount)
  var scratch = [Float32](repeating: 0, count: chunkSamples)
  emitState("ready", attempt: 1, extra: [("mode", "\"synthetic\"")])
  guard writeFrame(kind: kindFormat, seq: 0, payload: formatPayload(sampleRate: sampleRate, channels: channelCount)) else {
    return 3
  }
  var phase = 0.0
  let step = 2.0 * Double.pi * 440.0 / Double(sampleRate)
  var deliveredFrames: UInt64 = 0
  for frame in 0..<options.syntheticFrames {
    if terminationRequested { break }
    for i in 0..<Int(options.chunkFrames) {
      let value = Float32(0.5 * sin(phase))
      phase += step
      scratch[i * 2] = value
      scratch[i * 2 + 1] = value
    }
    let ok = writeFrame(
      kind: kindAudio, seq: frame + 1,
      payload: audioPayload(
        startSample: frame * UInt64(options.chunkFrames), samples: scratch, count: chunkSamples))
    if !ok { return 3 }
    deliveredFrames += 1
  }
  _ = writeFrame(
    kind: kindEnd, seq: options.syntheticFrames + 1,
    payload: endPayload(captured: deliveredFrames, delivered: deliveredFrames, dropped: 0, reason: endCompleted))
  emitState("end", attempt: 1, extra: [
    ("captured", "\(deliveredFrames)"), ("delivered", "\(deliveredFrames)"),
    ("dropped", "0"), ("cancelled", "false"),
  ])
  return 0
}

signal(SIGTERM, requestTermination)

guard let options = parseOptions(CommandLine.arguments) else {
  FileHandle.standardError.write(Data("usage: urbuddy-audio-capture [--run-ms N] [--synthetic-frames N] [--chunk-frames N]\n".utf8))
  exit(2)
}

#if os(macOS)
let code: Int32 = options.syntheticFrames > 0 ? runSynthetic(options: options) : RealCapture(options: options).run()
#else
let code: Int32 = options.syntheticFrames > 0 ? runSynthetic(options: options) : {
  FileHandle.standardError.write(Data("{\"state\":\"error\",\"stage\":\"unsupported-platform\"}\n".utf8))
  return 3
}()
#endif

exit(code)
