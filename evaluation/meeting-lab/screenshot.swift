import AppKit
import CoreText
import Foundation

struct CellStyle {
    var color = NSColor(calibratedRed: 0xF4 / 255, green: 0xF0 / 255, blue: 0xDF / 255, alpha: 1)
    var bold = false
    var dim = false
}

struct Cell {
    let character: String
    let style: CellStyle
}

let background = NSColor(calibratedRed: 0x15 / 255, green: 0x15 / 255, blue: 0x15 / 255, alpha: 1)

func parseColor(_ values: ArraySlice<Int>, style: inout CellStyle) {
    guard values.count >= 5, values[values.startIndex] == 38,
          values[values.startIndex + 1] == 2 else { return }
    let red = values[values.startIndex + 2]
    let green = values[values.startIndex + 3]
    let blue = values[values.startIndex + 4]
    guard (0...255).contains(red), (0...255).contains(green), (0...255).contains(blue) else { return }
    style.color = NSColor(calibratedRed: CGFloat(red) / 255, green: CGFloat(green) / 255,
                          blue: CGFloat(blue) / 255, alpha: 1)
}

func parseANSI(_ input: String) -> [[Cell]] {
    var lines: [[Cell]] = [[]]
    var style = CellStyle()
    var index = input.startIndex

    while index < input.endIndex {
        if input[index] == "\u{1B}" {
            let afterEscape = input.index(after: index)
            if afterEscape < input.endIndex, input[afterEscape] == "[" {
                var cursor = input.index(after: afterEscape)
                var parameter = ""
                while cursor < input.endIndex {
                    let scalar = input[cursor]
                    parameter.append(scalar)
                    cursor = input.index(after: cursor)
                    if scalar == "m" { break }
                }
                if parameter.last == "m" {
                    let rawValues = parameter.dropLast().split(separator: ";", omittingEmptySubsequences: false)
                    var values = [Int]()
                    var valid = true
                    for rawValue in rawValues {
                        guard let value = Int(rawValue.isEmpty ? "0" : rawValue) else { valid = false; break }
                        values.append(value)
                    }
                    if valid {
                        var valueIndex = 0
                        while valueIndex < values.count {
                            let value = values[valueIndex]
                            switch value {
                            case 0:
                                style = CellStyle()
                            case 1:
                                style.bold = true
                            case 2:
                                style.dim = true
                            case 22:
                                style.bold = false
                                style.dim = false
                            case 38:
                                if valueIndex + 4 < values.count, values[valueIndex + 1] == 2 {
                                    parseColor(values[(valueIndex)...], style: &style)
                                    valueIndex += 4
                                }
                            default:
                                break
                            }
                            valueIndex += 1
                        }
                        index = cursor
                        continue
                    }
                }
            }
        }

        let character = String(input[index])
        index = input.index(after: index)
        if character == "\n" {
            lines.append([])
        } else if character == "\r" {
            continue
        } else if character == "\t" {
            let spaces = 4 - (lines[lines.count - 1].count % 4)
            for _ in 0..<spaces { lines[lines.count - 1].append(Cell(character: " ", style: style)) }
        } else if character.unicodeScalars.allSatisfy({ $0.value >= 0x20 }) {
            lines[lines.count - 1].append(Cell(character: character, style: style))
        }
    }
    return lines
}

func nsColor(_ color: NSColor, dim: Bool) -> NSColor {
    guard dim else { return color }
    return color.blended(withFraction: 0.45, of: background) ?? color
}

func render(lines: [[Cell]], columns: Int, rows: Int, outputURL: URL) throws {
    let fontSize: CGFloat = 14
    let regular = CTFontCreateWithName("Menlo" as CFString, fontSize, nil)
    let bold = CTFontCreateWithName("Menlo-Bold" as CFString, fontSize, nil)
    let advance = CTFontGetAdvancesForGlyphs(regular, .horizontal, [CTFontGetGlyphWithName(regular, "M" as CFString)], nil, 1)
    let cellWidth = max(1, Int(ceil(advance)))
    let ascent = CTFontGetAscent(regular)
    let descent = CTFontGetDescent(regular)
    let leading = CTFontGetLeading(regular)
    let cellHeight = max(1, Int(ceil(ascent + descent + leading)))
    let width = max(1, columns * cellWidth)
    let height = max(1, rows * cellHeight)
    guard let bitmap = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                 bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                 bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        throw NSError(domain: "Screenshot", code: 1, userInfo: [NSLocalizedDescriptionKey: "could not create bitmap"])
    }
    bitmap.setFillColor(background.cgColor)
    bitmap.fill(CGRect(x: 0, y: 0, width: width, height: height))
    bitmap.textMatrix = .identity

    for row in 0..<min(rows, lines.count) {
        for column in 0..<min(columns, lines[row].count) {
            let cell = lines[row][column]
            let font = cell.style.bold ? bold : regular
            let attributes: [NSAttributedString.Key: Any] = [
                .font: font,
                .foregroundColor: nsColor(cell.style.color, dim: cell.style.dim),
            ]
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: cell.character, attributes: attributes))
            let x = CGFloat(column * cellWidth)
            let y = CGFloat(height - (row + 1) * cellHeight) + descent
            bitmap.textPosition = CGPoint(x: x, y: y)
            CTLineDraw(line, bitmap)
        }
    }
    guard let image = bitmap.makeImage() else {
        throw NSError(domain: "Screenshot", code: 2, userInfo: [NSLocalizedDescriptionKey: "could not create image"])
    }
    guard let destination = CGImageDestinationCreateWithURL(outputURL as CFURL, "public.png" as CFString, 1, nil) else {
        throw NSError(domain: "Screenshot", code: 3, userInfo: [NSLocalizedDescriptionKey: "could not create PNG destination"])
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw NSError(domain: "Screenshot", code: 4, userInfo: [NSLocalizedDescriptionKey: "could not write PNG"])
    }
}

func usage() -> Never {
    fputs("usage: screenshot.swift input.ansi output.png columns rows\n", stderr)
    exit(64)
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count == 4, let columns = Int(arguments[2]), let rows = Int(arguments[3]), columns > 0, rows > 0 else {
    usage()
}
let inputURL = URL(fileURLWithPath: arguments[0])
let outputURL = URL(fileURLWithPath: arguments[1])
do {
    let input = try String(contentsOf: inputURL, encoding: .utf8)
    try render(lines: parseANSI(input), columns: columns, rows: rows, outputURL: outputURL)
} catch {
    fputs("screenshot: \(error.localizedDescription)\n", stderr)
    exit(1)
}
