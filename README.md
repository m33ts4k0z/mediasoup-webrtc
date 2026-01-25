# Mediasoup WebRTC for Spacebar

A WebRTC server implementation compatible with Spacebar using the Mediasoup v3 media server library.

Supports both audio and video streaming.

## Supported environments
- Linux
- macOS
- Windows

## Requirements
- Node.js 20 or 22 (Node 24+ may break native addons)
- mediasoup v3.18.0+

## Usage

Install it to your Spacebar server:

```bash
npm install @spacebarchat/mediasoup-webrtc --no-save
```

Then configure your Spacebar `.env` to use this package:

```bash
WRTC_LIBRARY=@spacebarchat/mediasoup-webrtc
```

## Features

- Audio streaming with Opus codec
- Video streaming with H.264 codec
- RTX (retransmission) support for improved video quality
- Multiple workers for scalability
- Compatible with the Spacebar signaling protocol

## License

AGPL-3.0-only

