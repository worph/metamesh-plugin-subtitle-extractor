#!/bin/bash
# Generate media for subtitle-extractor integration tests.
# Run inside the test container (ffmpeg required); safe to run locally too.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Generating test fixtures..."

# 1. MKV with three text tracks — the shape real releases have:
#    s:0 SubRip, language eng
#    s:1 ASS,    language fre, forced (must stay ASS under outputFormat=native)
#    s:2 SubRip, language und (nothing declared)
if [ ! -f "with-subs.mkv" ]; then
    echo "Creating with-subs.mkv..."
    cat > eng.srt << 'EOF'
1
00:00:00,000 --> 00:00:01,000
The quick brown fox jumps over the lazy dog.

2
00:00:01,000 --> 00:00:02,000
Every good story starts somewhere.
EOF
    cat > fre.srt << 'EOF'
1
00:00:00,000 --> 00:00:01,000
Le renard brun saute par-dessus le chien paresseux.

2
00:00:01,000 --> 00:00:02,000
Chaque bonne histoire commence quelque part.
EOF
    cat > und.srt << 'EOF'
1
00:00:00,500 --> 00:00:01,500
~ ~ ~
EOF

    ffmpeg -y -f lavfi -i testsrc=duration=3:size=160x120:rate=12 \
           -i eng.srt -i fre.srt -i und.srt \
           -map 0:v -map 1:s -map 2:s -map 3:s \
           -c:v libx264 -preset ultrafast -crf 35 -pix_fmt yuv420p \
           -c:s:0 srt -c:s:1 ass -c:s:2 srt \
           -metadata:s:s:0 language=eng \
           -metadata:s:s:1 language=fre -disposition:s:1 forced \
           -metadata:s:s:2 language=und \
           with-subs.mkv
    rm -f eng.srt fre.srt und.srt
fi

# 2. MP4 with a mov_text track tagged in ISO 639-2/T (`deu`) — must be converted
#    to SRT and normalised to `ger`.
if [ ! -f "mov-text.mp4" ]; then
    echo "Creating mov-text.mp4..."
    cat > ger.srt << 'EOF'
1
00:00:00,000 --> 00:00:01,000
Der schnelle braune Fuchs springt über den faulen Hund.
EOF
    ffmpeg -y -f lavfi -i testsrc=duration=2:size=160x120:rate=12 \
           -i ger.srt \
           -map 0:v -map 1:s \
           -c:v libx264 -preset ultrafast -crf 35 -pix_fmt yuv420p \
           -c:s mov_text -metadata:s:s:0 language=deu \
           mov-text.mp4
    rm -f ger.srt
fi

echo "Test fixtures generated:"
ls -la *.mkv *.mp4 2>/dev/null || true
