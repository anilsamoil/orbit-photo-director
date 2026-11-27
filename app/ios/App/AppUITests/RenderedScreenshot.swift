import CoreGraphics
import Foundation
import ImageIO
import XCTest

private enum ProofScreenshotMarker: String {
    case map = "G1-map"
    case iss = "G1-iss"

    var rgb: (red: Int, green: Int, blue: Int) {
        switch self {
        case .map: (0, 255, 0)
        case .iss: (196, 90, 40)
        }
    }
}

// Keep sampling and thresholds in sync with app/scripts/check_ios_screenshot.py.
private struct ScreenshotPixels {
    let width: Int
    let height: Int
    let luminanceDeviation: Double
    let colorClusters: Int
    let placeholderBackground: Double
    let centralLight: Double
    let markerFraction: Double?

    var isNonBlank: Bool {
        luminanceDeviation >= 6 && (colorClusters >= 2 || (markerFraction ?? 0) >= 0.95)
    }

    var matchesPlaceholder: Bool {
        isNonBlank && placeholderBackground >= 0.75 && centralLight >= 0.001
    }

    var matchesProofMarker: Bool {
        isNonBlank && (markerFraction ?? 0) >= 0.01
    }

    var summary: String {
        let frame = "\(width)x\(height) " + String(
            format: "luminance SD %.2f, %ld color clusters, %.2f%% dark background, %.2f%% central light",
            luminanceDeviation, colorClusters, 100 * placeholderBackground, 100 * centralLight
        )
        guard let markerFraction else { return frame }
        return frame + String(format: ", %.2f%% fixture tile marker", 100 * markerFraction)
    }

    static func decodeSRGB(_ png: Data) -> CGContext? {
        guard let source = CGImageSourceCreateWithData(png as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
              let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        let width = image.width
        let height = image.height
        let rowBytes = width * 4
        guard width > 0, height > 0,
              let context = CGContext(
                data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: rowBytes,
                space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
              ) else { return nil }
        context.setBlendMode(.copy)
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context
    }

    static func measure(_ context: CGContext, marker: ProofScreenshotMarker?) -> ScreenshotPixels? {
        guard let data = context.data else { return nil }
        let width = context.width
        let height = context.height
        let bytes = data.assumingMemoryBound(to: UInt8.self)
        let step = max(1, min(width, height) / 300)
        let centralX = (width / 4)..<(width - width / 4)
        let centralY = (height / 4)..<(height - height / 4)
        // Exclude the Plan inset on the left of the iPad ISS view and the side dock.
        let markerX = (2 * width / 5)..<(width - 2 * width / 5)
        let markerRGB = marker?.rgb
        var samples = 0
        var centralSamples = 0
        var lightSamples = 0
        var backgroundSamples = 0
        var markerSamples = 0
        var matchingMarkerSamples = 0
        var luminanceSum = 0.0
        var luminanceSquares = 0.0
        var clusters = [Int](repeating: 0, count: 512)

        // The middle 80% skips the status bar, home indicator, and native G1 controls.
        for y in stride(from: height / 10, to: height - height / 10, by: step) {
            let row = bytes + y * context.bytesPerRow
            for x in stride(from: 0, to: width, by: step) {
                let pixel = row + x * 4
                let r = Int(pixel[0])
                let g = Int(pixel[1])
                let b = Int(pixel[2])
                let luminance = 0.2126 * Double(r) + 0.7152 * Double(g) + 0.0722 * Double(b)
                samples += 1
                luminanceSum += luminance
                luminanceSquares += luminance * luminance
                clusters[(r / 32) * 64 + (g / 32) * 8 + b / 32] += 1
                if abs(r - 0x10) <= 16 && abs(g - 0x18) <= 16 && abs(b - 0x21) <= 16 {
                    backgroundSamples += 1
                }
                if centralX.contains(x) && centralY.contains(y) {
                    centralSamples += 1
                    if luminance >= 160 { lightSamples += 1 }
                }
                if let markerRGB, markerX.contains(x), centralY.contains(y) {
                    markerSamples += 1
                    if pixel[3] == 255 && abs(r - markerRGB.red) <= 32 &&
                        abs(g - markerRGB.green) <= 32 && abs(b - markerRGB.blue) <= 32 {
                        matchingMarkerSamples += 1
                    }
                }
            }
        }

        let mean = luminanceSum / Double(samples)
        return ScreenshotPixels(
            width: width, height: height,
            luminanceDeviation: sqrt(max(0, luminanceSquares / Double(samples) - mean * mean)),
            colorClusters: clusters.filter { $0 * 1_000 >= samples }.count,
            placeholderBackground: Double(backgroundSamples) / Double(samples),
            centralLight: Double(lightSamples) / Double(max(1, centralSamples)),
            markerFraction: marker.map { _ in Double(matchingMarkerSamples) / Double(max(1, markerSamples)) }
        )
    }
}

extension XCTestCase {
    @MainActor
    func attachRenderedScreenshot(named name: String, requiresPlaceholder: Bool = false) {
        let marker = ProofScreenshotMarker(rawValue: name)
        guard requiresPlaceholder || marker != nil else {
            return failWithScreenshot("Missing fixture marker definition", named: name)
        }
        let timeout: TimeInterval = 30
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        var frame: XCUIScreenshot
        var pixels: ScreenshotPixels?
        repeat {
            frame = XCUIScreen.main.screenshot()
            let context = ScreenshotPixels.decodeSRGB(frame.pngRepresentation)
            pixels = context.flatMap { ScreenshotPixels.measure($0, marker: marker) }
            if let context, let pixels, requiresPlaceholder ? pixels.matchesPlaceholder : pixels.matchesProofMarker {
                if requiresPlaceholder {
                    attachScreenshot(frame, named: name)
                } else if !attachProofScreenshot(context, named: name) {
                    failWithScreenshot("Could not encode the sRGB proof frame", named: name, frame: frame)
                }
                return
            }

            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            if remaining <= 0 { break }
            let nextPoll = XCTestExpectation(description: "Next screenshot sample")
            _ = XCTWaiter.wait(for: [nextPoll], timeout: min(0.25, remaining))
        } while ProcessInfo.processInfo.systemUptime < deadline

        let expected = requiresPlaceholder ? "a dark placeholder with visible light text" : "the tab's fixture tile marker in the canvas"
        let summary = pixels?.summary ?? "image could not be decoded"
        failWithScreenshot("\(name) did not render \(expected) within \(Int(timeout)) seconds. Last frame: \(summary)",
                           named: name, frame: frame)
    }

    @MainActor
    func failWithScreenshot(_ message: String, named name: String, frame: XCUIScreenshot? = nil,
                            file: StaticString = #filePath, line: UInt = #line) {
        attachScreenshot(frame ?? XCUIScreen.main.screenshot(), named: "\(name)-failed")
        XCTFail(message, file: file, line: line)
    }

    @MainActor
    private func attachScreenshot(_ frame: XCUIScreenshot, named name: String) {
        let attachment = XCTAttachment(screenshot: frame)
        keepScreenshot(attachment, named: name)
    }

    @MainActor
    private func attachProofScreenshot(_ context: CGContext, named name: String) -> Bool {
        let png = NSMutableData()
        guard let image = context.makeImage(),
              let encoder = CGImageDestinationCreateWithData(png as CFMutableData, "public.png" as CFString, 1, nil)
        else { return false }
        CGImageDestinationAddImage(encoder, image, nil)
        guard CGImageDestinationFinalize(encoder) else { return false }
        keepScreenshot(XCTAttachment(data: png as Data, uniformTypeIdentifier: "public.png"), named: name)
        return true
    }

    @MainActor
    private func keepScreenshot(_ attachment: XCTAttachment, named name: String) {
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
