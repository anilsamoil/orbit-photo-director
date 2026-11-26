#!/usr/bin/env python3
"""Verify the rendered pixels in an exported iOS simulator screenshot."""

import argparse
from collections import Counter
import math
from pathlib import Path
import struct
import sys
import zlib


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PROOF_MARKERS = {"map": (0, 255, 0), "iss": (196, 90, 40)}


def read_png(path):
    data = path.read_bytes()
    if not data.startswith(PNG_SIGNATURE):
        raise ValueError("invalid PNG signature")

    offset = len(PNG_SIGNATURE)
    compressed = bytearray()
    width = height = channels = 0
    while offset + 12 <= len(data):
        length, kind = struct.unpack_from(">I4s", data, offset)
        end = offset + 8 + length
        if end + 4 > len(data):
            raise ValueError("truncated PNG chunk")
        crc, = struct.unpack_from(">I", data, end)
        if zlib.crc32(data[offset + 4:end]) != crc:
            raise ValueError(f"invalid {kind!r} PNG checksum")
        payload = data[offset + 8:end]
        if offset == len(PNG_SIGNATURE):
            if kind != b"IHDR" or length != 13:
                raise ValueError("missing or invalid PNG header")
            width, height, depth, color, compression, filter_method, interlace = struct.unpack(
                ">IIBBBBB", payload
            )
            if width == 0 or height == 0:
                raise ValueError(f"invalid PNG dimensions {width}x{height}")
            if depth != 8 or color not in (2, 6) or (compression, filter_method, interlace) != (0, 0, 0):
                raise ValueError("expected an 8-bit non-interlaced RGB or RGBA PNG")
            channels = 3 if color == 2 else 4
        elif kind == b"IDAT":
            compressed.extend(payload)
        elif kind == b"IEND":
            if length != 0 or end + 4 != len(data):
                raise ValueError("invalid PNG end chunk")
            break
        elif kind == b"tRNS" or (kind[:1].isupper() and kind != b"PLTE"):
            raise ValueError(f"unsupported PNG chunk {kind!r}")
        offset = end + 4
    else:
        raise ValueError("missing PNG end chunk")

    expected_size = height * (1 + width * channels)
    decoder = zlib.decompressobj()
    try:
        scanlines = decoder.decompress(compressed, expected_size + 1)
    except (OverflowError, zlib.error) as error:
        raise ValueError(f"invalid PNG image data: {error}") from error
    if len(scanlines) != expected_size or not decoder.eof or decoder.unused_data:
        raise ValueError("incomplete or oversized PNG image data")
    return width, height, channels, scanlines


def paeth(left, above, upper_left):
    estimate = left + above - upper_left
    left_distance = abs(estimate - left)
    above_distance = abs(estimate - above)
    diagonal_distance = abs(estimate - upper_left)
    if left_distance <= above_distance and left_distance <= diagonal_distance:
        return left
    if above_distance <= diagonal_distance:
        return above
    return upper_left


def undo_filter(filter_type, row, prior, channels):
    # PNG predictors operate on bytes and use zero for missing neighbors.
    if filter_type == 0:
        return row
    if filter_type == 2:
        return bytearray((byte + above) & 255 for byte, above in zip(row, prior))
    if filter_type not in (1, 3, 4):
        raise ValueError(f"invalid PNG scanline filter {filter_type}")

    for index, byte in enumerate(row):
        left_index = index - channels
        left = row[left_index] if left_index >= 0 else 0
        if filter_type == 1:
            prediction = left
        elif filter_type == 3:
            prediction = (left + prior[index]) // 2
        else:
            upper_left = prior[left_index] if left_index >= 0 else 0
            prediction = paeth(left, prior[index], upper_left)
        row[index] = (byte + prediction) & 255
    return row


def validate_screenshot(path, *, launch=False, proof_tab=None):
    """Print pixel statistics and raise ValueError if the screenshot is unacceptable."""
    if proof_tab is not None and (launch or proof_tab not in PROOF_MARKERS):
        raise ValueError(f"invalid proof screenshot mode {proof_tab!r}")
    marker = PROOF_MARKERS.get(proof_tab)
    width, height, channels, scanlines = read_png(path)
    row_bytes = width * channels
    prior = bytearray(row_bytes)
    stride = max(1, min(width, height) // 300)
    top, bottom = height // 10, height - height // 10
    center_left, center_right = width // 4, width - width // 4
    center_top, center_bottom = height // 4, height - height // 4
    # Match the sRGB proof frame and canvas sampling region used by XCTest.
    marker_left, marker_right = 2 * width // 5, width - 2 * width // 5
    clusters = Counter()
    count = dark = center = light = 0
    marker_region = matching_marker = 0
    luminance_sum = luminance_square_sum = 0.0

    # Use the middle 80% of the frame so status and home indicators cannot prove rendering.
    for y in range(height):
        offset = y * (row_bytes + 1)
        row = bytearray(scanlines[offset + 1:offset + 1 + row_bytes])
        prior = undo_filter(scanlines[offset], row, prior, channels)
        if not top <= y < bottom or (y - top) % stride:
            continue
        for x in range(0, width, stride):
            pixel = x * channels
            red, green, blue = prior[pixel:pixel + 3]
            opaque = channels == 3 or prior[pixel + 3] == 255
            if not opaque:
                alpha = prior[pixel + 3]
                red, green, blue = ((value * alpha + 127) // 255 for value in (red, green, blue))
            luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
            count += 1
            luminance_sum += luminance
            luminance_square_sum += luminance * luminance
            clusters[red // 32, green // 32, blue // 32] += 1
            if abs(red - 0x10) <= 16 and abs(green - 0x18) <= 16 and abs(blue - 0x21) <= 16:
                dark += 1
            if center_left <= x < center_right and center_top <= y < center_bottom:
                center += 1
                light += luminance >= 160
                if marker is not None and marker_left <= x < marker_right:
                    marker_region += 1
                    matching_marker += (
                        opaque
                        and abs(red - marker[0]) <= 32
                        and abs(green - marker[1]) <= 32
                        and abs(blue - marker[2]) <= 32
                    )

    variance = luminance_square_sum / count - (luminance_sum / count) ** 2
    deviation = math.sqrt(max(0.0, variance))
    distinct = sum(pixels * 1000 >= count for pixels in clusters.values())
    dark_fraction = dark / count
    light_fraction = light / center if center else 0.0
    marker_fraction = matching_marker / marker_region if marker_region else 0.0
    marker_stats = f", {proof_tab} fixture tile marker {marker_fraction:.2%}" if marker is not None else ""
    print(
        f"{path.name}: {width}x{height}, {count} samples, luminance std-dev {deviation:.2f}, "
        f"color clusters {distinct}, dark background {dark_fraction:.2%}, "
        f"light center {light_fraction:.2%}{marker_stats}",
        flush=True,
    )
    if deviation < 6 or distinct < 2:
        raise ValueError("uniform or near-blank frame (need luminance std-dev >= 6 and at least two color clusters)")
    if launch and (dark_fraction < 0.75 or light_fraction < 0.001):
        raise ValueError("missing SNAP placeholder pixels (need >= 75% dark background and >= 0.1% light center)")
    if marker is not None and marker_fraction < 0.01:
        raise ValueError(f"missing {proof_tab} fixture tile marker (need >= 1% of the central canvas sampling region)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--launch", action="store_true", help="also require the dark SNAP placeholder with light text")
    modes.add_argument("--proof-tab", choices=PROOF_MARKERS, help="also require the tab's fixture tile marker")
    parser.add_argument("png", nargs="+", type=Path)
    args = parser.parse_args()
    failed = False
    for path in args.png:
        try:
            validate_screenshot(path, launch=args.launch, proof_tab=args.proof_tab)
        except (OSError, ValueError) as error:
            print(f"Rejected {path}: {error}", file=sys.stderr)
            failed = True
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
