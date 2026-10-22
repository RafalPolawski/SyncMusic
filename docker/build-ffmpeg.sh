#!/bin/sh
# Builds a small, fully static ffmpeg/ffprobe pair that only knows what
# SyncMusic needs: decoding common audio formats, encoding Opus (libopus) and
# AAC, and writing Ogg / MP4 audio files. About 10 MB instead of the ~280 MB
# of a full static build.
#
# Usage: build-ffmpeg.sh <source-dir> <prefix>
set -eu

src=$1
prefix=$2
cd "$src"

./configure \
  --prefix="$prefix" \
  --pkg-config-flags=--static \
  --extra-cflags="-O2" \
  --extra-ldflags="-static" \
  --enable-static --disable-shared \
  --disable-autodetect --disable-everything \
  --disable-doc --disable-debug --disable-network \
  --disable-ffplay --enable-ffmpeg --enable-ffprobe \
  --enable-avcodec --enable-avformat --enable-avfilter --enable-swresample \
  --enable-libopus \
  --enable-protocol=file,pipe \
  --enable-demuxer=aac,aiff,ape,asf,flac,matroska,mov,mp3,ogg,wav,wv \
  --enable-decoder=aac,aac_fixed,aac_latm,ac3,alac,ape,flac,mp2,mp3,mp3float,opus,vorbis,wavpack,wmav1,wmav2,wmapro \
  --enable-decoder=pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f32be,pcm_u8,pcm_alaw,pcm_mulaw \
  --enable-parser=aac,aac_latm,ac3,flac,mpegaudio,opus,vorbis \
  --enable-encoder=aac,libopus \
  --enable-muxer=ipod,mp4,ogg,opus,null \
  --enable-bsf=aac_adtstoasc \
  --enable-filter=aformat,anull,aresample,atrim,abuffer,abuffersink,format,null,volume

make -j"$(nproc)"
make install
strip "$prefix/bin/ffmpeg" "$prefix/bin/ffprobe"
