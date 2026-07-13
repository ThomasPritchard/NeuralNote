# Audio fixture provenance

`aac-lc-fragmented.m4a` is synthetic test audio. It contains two 0.5-second
sine waves (440 Hz left, 880 Hz right) at 44.1 kHz, encoded as stereo AAC-LC
inside a fragmented M4A container.

It was generated once on 2026-07-11 with FFmpeg 8.1.2. Tests consume the
checked-in bytes and never invoke FFmpeg, `afconvert`, yt-dlp, or a build script.

Generation commands:

```sh
ffmpeg -f lavfi -i sine=frequency=440:duration=0.5:sample_rate=44100 \
  -f lavfi -i sine=frequency=880:duration=0.5:sample_rate=44100 \
  -filter_complex '[0:a][1:a]amerge=inputs=2[a]' -map '[a]' \
  -c:a pcm_s16le synthetic-stereo.wav

ffmpeg -i synthetic-stereo.wav -c:a aac -profile:a aac_low -b:a 64000 \
  -movflags +frag_keyframe+empty_moov+default_base_moof \
  aac-lc-fragmented.m4a
```

Verification: FFprobe reports AAC profile `LC`, codec tag `mp4a`, 44,100 Hz,
two channels, and 0.523220 seconds. The file contains `moof` and `mdat` boxes.

SHA-256: `d223f4239676021d56ebf51883c0586fc517ed4f07cc1256f36a4be853b54cf8`

`aac-lc-truncated.m4a` is the first 1,500 bytes of the fixture above. It keeps
the complete `moov`, `moof`, and `trun` metadata plus two complete AAC sample
payloads, then ends during the third sample inside the declared `mdat` box.
This passes container and track probing plus decoder construction before the
real decode path rejects the stream for producing zero frames. It was derived
with:

```sh
cp aac-lc-fragmented.m4a aac-lc-truncated.m4a
truncate -s 1500 aac-lc-truncated.m4a
```

SHA-256: `661f1709123ea0e1b051d4c29976182d385092ccce4d68f2da65db421dc3bb08`
