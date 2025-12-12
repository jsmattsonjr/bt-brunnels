#!/bin/bash
# Generate simple placeholder icons using ImageMagick (if available)
# Or use any image editor to create 16x16, 48x48, and 128x128 PNG icons

# Simple colored squares as placeholders
for size in 16 48 128; do
  convert -size ${size}x${size} xc:#3182ce \
    -fill white -gravity center -pointsize $((size/2)) -annotate 0 "B" \
    icon${size}.png 2>/dev/null || \
  echo "ImageMagick not available. Please create icon${size}.png manually."
done

echo "Icon placeholders created (or need manual creation)"
