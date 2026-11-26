import CoreAudio
import Darwin
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
  var ringSlots: UInt32 = 64
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
    case "--ring-slots":
      guard let value = takeNumber(), value >= 1, value <= 1024 else { return nil }
      out.ringSlots = UInt32(value)
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

func audioPayload(startFrame: UInt64, samples: [Float32], count: Int) -> Data {
  var payload = Data()
  payload.reserveCapacity(8 + count * 4)
  appendLE(startFrame, to: &payload)
  samples.withUnsafeBytes { payload.append(contentsOf: $0.prefix(count * 4)) }
  return payload
}

func endPayload(
  captured: UInt64, delivered: UInt64, dropped: UInt64, reason: UInt16, sourceFrames: UInt64
) -> Data {
  var payload = Data()
  appendLE(captured, to: &payload)
  appendLE(delivered, to: &payload)
  appendLE(dropped, to: &payload)
  appendLE(reason, to: &payload)
  appendLE(sourceFrames, to: &payload)
  return payload
}

final class Handoff: @unchecked Sendable {
  private var lock = os_unfair_lock()
  private var slots: [[Float32]]
  private var starts: [UInt64]
  private var filled: [Int]
  private var head = 0
  private var tail = 0
  private var count = 0
  private let channels: Int
  private var capturedChunks: UInt64 = 0
  private var droppedChunks: UInt64 = 0
  private var sourceFrames: UInt64 = 0
  private var layout: (buffers: Int, sizes: [Int])?

  init(slotCount: Int, slotSamples: Int, channels: Int) {
    slots = Array(repeating: Array(repeating: 0, count: slotSamples), count: slotCount)
    starts = Array(repeating: 0, count: slotCount)
    filled = Array(repeating: 0, count: slotCount)
    self.channels = channels
  }

  var slotSamples: Int { slots.first?.count ?? 0 }

  @discardableResult
  func push(sampleCount: Int, body: (UnsafeMutablePointer<Float32>) -> Void) -> UInt64? {
    os_unfair_lock_lock(&lock)
    defer { os_unfair_lock_unlock(&lock) }
    guard sampleCount > 0, sampleCount % channels == 0 else {
      droppedChunks += 1
      sourceFrames += UInt64(max(sampleCount, 0) / max(channels, 1))
      return nil
    }
    let start = sourceFrames
    sourceFrames += UInt64(sampleCount / channels)
    if count == slots.count || sampleCount > slots[tail].count {
      droppedChunks += 1
      return nil
    }
    let slot = tail
    slots[slot].withUnsafeMutableBufferPointer { dest in
      if let base = dest.baseAddress {
        body(base)
      }
    }
    starts[slot] = start
    filled[slot] = sampleCount
    tail = (tail + 1) % slots.count
    count += 1
    capturedChunks += 1
    return start
  }

  func pop(into dest: inout [Float32]) -> (start: UInt64, count: Int)? {
    os_unfair_lock_lock(&lock)
    defer { os_unfair_lock_unlock(&lock) }
    if count == 0 { return nil }
    let slot = head
    let n = filled[slot]
    let start = starts[slot]
    dest.withUnsafeMutableBufferPointer { out in
      out.baseAddress?.update(from: slots[slot], count: min(n, out.count))
    }
    head = (head + 1) % slots.count
    count -= 1
    return (start, min(n, dest.count))
  }

  func hasPending() -> Bool {
    os_unfair_lock_lock(&lock)
    defer { os_unfair_lock_unlock(&lock) }
    return count > 0
  }

  func hasLayout() -> Bool {
    os_unfair_lock_lock(&lock)
    defer { os_unfair_lock_unlock(&lock) }
    return layout != nil
  }

  func noteLayout(buffers: Int, sizes: [Int]) {
    os_unfair_lock_lock(&lock)
    defer { os_unfair_lock_unlock(&lock) }
    if layout == nil {
      layout = (buffers, sizes)
    }
  }

  func takeLayout() -> (buffers: Int, sizes: [Int])? {
    os_unfair_lock_lock(&lock)
    defer { os_unfair_lock_unlock(&lock) }
    let out = layout
    layout = nil
    return out
  }

  func snapshot() -> (captured: UInt64, dropped: UInt64, sourceFrames: UInt64) {
    os_unfair_lock_lock(&lock)
    defer { os_unfair_lock_unlock(&lock) }
    return (capturedChunks, droppedChunks, sourceFrames)
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
  var handoff: Handoff?
  var channels: UInt32 = 0

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
    handoff = Handoff(
      slotCount: Int(options.ringSlots), slotSamples: slotSamples, channels: Int(channels))
    guard let handoff else { return false }
    var created: AudioDeviceIOProcID?
    let createStatus = AudioDeviceCreateIOProcIDWithBlock(&created, aggID, nil) {
      _, inInputData, _, _, _ in
      let bufferCount = Int(inInputData.pointee.mNumberBuffers)
      guard bufferCount >= 1 else { return }
      guard let baseOffset = MemoryLayout<AudioBufferList>.offset(of: \.mBuffers) else { return }
      let first = (UnsafeRawPointer(inInputData) + baseOffset).assumingMemoryBound(to: AudioBuffer.self)
      var totalBytes = 0
      var valid = true
      for i in 0..<bufferCount {
        let buf = first[i]
        guard let data = buf.mData else { continue }
        if Int(bitPattern: data) % 4 != 0 || buf.mDataByteSize % 4 != 0 {
          valid = false
          break
        }
        totalBytes += Int(buf.mDataByteSize)
      }
      if !valid || totalBytes == 0 { return }
      if !handoff.hasLayout() {
        var sizes = [Int]()
        for i in 0..<bufferCount {
          sizes.append(Int(first[i].mDataByteSize))
        }
        handoff.noteLayout(buffers: bufferCount, sizes: sizes)
      }
      handoff.push(sampleCount: totalBytes / 4) { dest in
        var offset = 0
        for i in 0..<bufferCount {
          let buf = first[i]
          guard let data = buf.mData else { continue }
          let floats = data.assumingMemoryBound(to: Float32.self)
          let count = Int(buf.mDataByteSize) / 4
          dest.advanced(by: offset).update(from: floats, count: count)
          offset += count
        }
      }
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

  func teardown() -> Bool {
    var ok = true
    if let procID, aggID != 0 {
      if AudioDeviceStop(aggID, procID) != noErr { ok = false }
      if AudioDeviceDestroyIOProcID(aggID, procID) != noErr { ok = false }
      self.procID = nil
    }
    if aggID != 0 {
      if AudioHardwareDestroyAggregateDevice(aggID) != noErr { ok = false }
      aggID = 0
    }
    destroyTap()
    return ok
  }

  func stopEngine() -> Bool {
    guard let procID, aggID != 0 else { return false }
    let status = AudioDeviceStop(aggID, procID)
    self.procID = nil
    return status == noErr
  }

  func drain(handoff: Handoff, seq: inout UInt64, deliveredFrames: inout UInt64) -> Bool {
    var scratch = [Float32](repeating: 0, count: handoff.slotSamples)
    while let popped = handoff.pop(into: &scratch) {
      let ok = writeFrame(
        kind: kindAudio, seq: seq,
        payload: audioPayload(startFrame: popped.start, samples: scratch, count: popped.count))
      deliveredFrames += 1
      seq += 1
      if !ok { return false }
    }
    return true
  }

  func run() -> Int32 {
    guard #available(macOS 14.2, *) else {
      emitState("error", attempt: 0, extra: [("stage", "\"unsupported-os\"")])
      return 3
    }
    var format = AudioStreamBasicDescription()
    guard acquire(format: &format) else { return 3 }
    guard let handoff else {
      teardown()
      return 3
    }
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
    var scratch = [Float32](repeating: 0, count: handoff.slotSamples)
    var layoutReported = false
    let deadline = options.runMs == 0 ? nil as Date? : Date(timeIntervalSinceNow: Double(options.runMs) / 1000.0)
    var reason = endCompleted
    var seq: UInt64 = 1
    var deliveredFrames: UInt64 = 0
    var writerAlive = true
    while writerAlive {
      if terminationRequested {
        reason = endCancelled
        break
      }
      if let deadline, Date() >= deadline { break }
      if !layoutReported, let layout = handoff.takeLayout() {
        layoutReported = true
        emitState("signal", attempt: 1, extra: [
          ("buffers", "\(layout.buffers)"), ("bytes", "\"\(layout.sizes.map(String.init).joined(separator: ","))\""),
        ])
      }
      if let popped = handoff.pop(into: &scratch) {
        let ok = writeFrame(
          kind: kindAudio, seq: seq,
          payload: audioPayload(startFrame: popped.start, samples: scratch, count: popped.count))
        deliveredFrames += 1
        seq += 1
        if !ok { writerAlive = false }
      } else {
        Thread.sleep(forTimeInterval: 0.002)
      }
    }
    let stopped = stopEngine()
    let drained = drain(handoff: handoff, seq: &seq, deliveredFrames: &deliveredFrames)
    let snapshot = handoff.snapshot()
    _ = writeFrame(
      kind: kindEnd, seq: seq,
      payload: endPayload(
        captured: snapshot.captured, delivered: deliveredFrames, dropped: snapshot.dropped,
        reason: reason, sourceFrames: snapshot.sourceFrames))
    let tornDown = teardown()
    emitState("end", attempt: 1, extra: [
      ("captured", "\(snapshot.captured)"), ("delivered", "\(deliveredFrames)"),
      ("dropped", "\(snapshot.dropped)"), ("cancelled", reason == endCancelled ? "true" : "false"),
    ])
    return stopped && drained && tornDown ? 0 : 3
  }
}

func runSynthetic(options: Options) -> Int32 {
  let sampleRate: UInt32 = 48_000
  let channelCount = 2
  let chunkSamples = Int(options.chunkFrames) * channelCount
  let handoff = Handoff(slotCount: Int(options.ringSlots), slotSamples: chunkSamples, channels: channelCount)
  emitState("ready", attempt: 1, extra: [("mode", "\"synthetic\"")])
  guard writeFrame(kind: kindFormat, seq: 0, payload: formatPayload(sampleRate: sampleRate, channels: UInt16(channelCount))) else {
    return 3
  }
  var phase = 0.0
  let step = 2.0 * Double.pi * 440.0 / Double(sampleRate)
  var produced: UInt64 = 0
  var seq: UInt64 = 1
  var deliveredFrames: UInt64 = 0
  var scratch = [Float32](repeating: 0, count: chunkSamples)
  var reason = endCompleted
  while produced < options.syntheticFrames && !terminationRequested {
    handoff.push(sampleCount: chunkSamples) { dest in
      for i in 0..<Int(options.chunkFrames) {
        let value = Float32(0.5 * sin(phase))
        phase += step
        dest[i * 2] = value
        dest[i * 2 + 1] = value
      }
    }
    produced += 1
    while let popped = handoff.pop(into: &scratch) {
      if terminationRequested { break }
      let ok = writeFrame(
        kind: kindAudio, seq: seq,
        payload: audioPayload(startFrame: popped.start, samples: scratch, count: popped.count))
      deliveredFrames += 1
      seq += 1
      if !ok { return 3 }
    }
  }
  if terminationRequested {
    reason = endCancelled
  } else {
    while let popped = handoff.pop(into: &scratch) {
      let ok = writeFrame(
        kind: kindAudio, seq: seq,
        payload: audioPayload(startFrame: popped.start, samples: scratch, count: popped.count))
      deliveredFrames += 1
      seq += 1
      if !ok { return 3 }
    }
  }
  let snapshot = handoff.snapshot()
  _ = writeFrame(
    kind: kindEnd, seq: seq,
    payload: endPayload(
      captured: snapshot.captured, delivered: deliveredFrames, dropped: snapshot.dropped,
      reason: reason, sourceFrames: snapshot.sourceFrames))
  emitState("end", attempt: 1, extra: [
    ("captured", "\(snapshot.captured)"), ("delivered", "\(deliveredFrames)"),
    ("dropped", "\(snapshot.dropped)"), ("cancelled", reason == endCancelled ? "true" : "false"),
  ])
  return 0
}

signal(SIGTERM, requestTermination)

guard let options = parseOptions(CommandLine.arguments) else {
  FileHandle.standardError.write(Data("usage: urbuddy-audio-capture [--run-ms N] [--synthetic-frames N] [--chunk-frames N] [--ring-slots N]\n".utf8))
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
