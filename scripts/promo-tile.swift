import AppKit

// Builds the 440×280 store promo tile. Usage: swift scripts/promo-tile.swift extension/icons/128.png <out.png>
let args = CommandLine.arguments
let iconURL = URL(fileURLWithPath: args[1])
let outURL = URL(fileURLWithPath: args[2])
let W = 440, H = 280

let cs = CGColorSpaceCreateDeviceRGB()
let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0,
                    space: cs, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!

// Background: Chrome dark grey, matching the screenshots.
ctx.setFillColor(CGColor(red: 0x20/255.0, green: 0x21/255.0, blue: 0x24/255.0, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))

// Icon on the left, vertically centred.
let src = CGImageSourceCreateWithURL(iconURL as CFURL, nil)!
let icon = CGImageSourceCreateImageAtIndex(src, 0, nil)!
let iconSize: CGFloat = 112
ctx.interpolationQuality = .high
ctx.draw(icon, in: CGRect(x: 36, y: (CGFloat(H) - iconSize) / 2, width: iconSize, height: iconSize))

// Text via AppKit on the same context.
NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
func draw(_ s: String, size: CGFloat, weight: NSFont.Weight, gray: CGFloat, x: CGFloat, y: CGFloat) {
  let attrs: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: size, weight: weight),
    .foregroundColor: NSColor(white: gray, alpha: 1),
  ]
  NSAttributedString(string: s, attributes: attrs).draw(at: NSPoint(x: x, y: y))
}
let tx: CGFloat = 172
draw("Focus Bars", size: 38, weight: .bold, gray: 1.0, x: tx, y: 146)
draw("A bookmark bar", size: 20, weight: .regular, gray: 0.78, x: tx, y: 110)
draw("for each window", size: 20, weight: .regular, gray: 0.78, x: tx, y: 84)

let img = ctx.makeImage()!
let rep = NSBitmapImageRep(cgImage: img)
try! rep.representation(using: .png, properties: [:])!.write(to: outURL)
