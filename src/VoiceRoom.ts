import type { types as MediasoupTypes } from "mediasoup";
import {
    MEDIA_CODECS,
    MediasoupSignalingDelegate,
    RouterType,
} from "./MediasoupSignalingDelegate.js";
import { MediasoupWebRtcClient } from "./MediasoupWebRtcClient.js";
import type { Codec, RtpHeader } from "@spacebarchat/spacebar-webrtc-types";

type RtpCodecCapability = MediasoupTypes.RtpCodecCapability;
type Transport = MediasoupTypes.Transport;

/** Interval (ms) for requesting keyframes in stream rooms so viewers get smooth video. */
const STREAM_KEYFRAME_INTERVAL_MS = 1000;

export class VoiceRoom {
    private _clients: Map<string, MediasoupWebRtcClient>;
    private _id: string;
    private _sfu: MediasoupSignalingDelegate;
    private _type: "guild-voice" | "dm-voice" | "stream";
    private _router: RouterType;
    /** Periodic keyframe requests for stream rooms; cleared when room has no clients. */
    private _keyframeIntervalId: ReturnType<typeof setInterval> | null = null;

    constructor(
        id: string,
        type: "guild-voice" | "dm-voice" | "stream",
        sfu: MediasoupSignalingDelegate,
        router: RouterType
    ) {
        this._id = id;
        this._type = type;
        this._clients = new Map();
        this._sfu = sfu;
        this._router = router;
    }

    onClientJoin = (client: MediasoupWebRtcClient) => {
        // Stream rooms: key by user_id:session_id so streamer + viewer (same user) can coexist
        const key =
            this._type === "stream" && client.sessionId
                ? `${client.user_id}:${client.sessionId}`
                : client.user_id;
        client.roomClientKey = key;
        this._clients.set(key, client);
        if (this._type === "stream") {
            this.startKeyframeIntervalIfNeeded();
        }
    };

    onClientOffer = (
        client: MediasoupWebRtcClient,
        transport: Transport,
        codecs: Codec[],
        rtpHeaders: RtpHeader[]
    ) => {
        client.transport = transport;
        client.codecs = codecs;
        client.headerExtensions = rtpHeaders.filter((header) =>
            [
                "urn:ietf:params:rtp-hdrext:sdes:mid",
                "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id",
                "urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id",
                "http://tools.ietf.org/html/draft-ietf-avtext-framemarking-07",
                "urn:ietf:params:rtp-hdrext:framemarking",
                "urn:ietf:params:rtp-hdrext:ssrc-audio-level",
                "urn:3gpp:video-orientation",
                "urn:ietf:params:rtp-hdrext:toffset",
                "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01",
                "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time",
                "http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time",
                "http://www.webrtc.org/experiments/rtp-hdrext/playout-delay",
            ].includes(header.uri)
        );

        // Map MEDIA_CODECS to client's codec capabilities with proper payload types
        const supportedCodecs: RtpCodecCapability[] = [];

        // 1. Add Audio/Video codecs (skip RTX for now)
        for (const codec of MEDIA_CODECS) {
            if (codec.mimeType.toLowerCase() === "video/rtx") continue;

            const codecName = codec.mimeType.split("/")[1];
            let clientCodec = codecs.find((c) => c.name.toUpperCase() === codecName.toUpperCase());

            // For H264, try to match the profile-level-id if available
            if (codecName.toLowerCase() === "h264" && codec.parameters?.["profile-level-id"]) {
                const requiredProfile = codec.parameters["profile-level-id"];
                const exactMatch = codecs.find((c) => 
                    c.name.toUpperCase() === "H264" && 
                    (c as any).parameters?.["profile-level-id"] === requiredProfile
                );
                console.log(`[VoiceRoom] H264 matching for ${requiredProfile}. Exact match found?`, !!exactMatch, exactMatch ? `PT ${exactMatch.payload_type}` : '');
                if (exactMatch) {
                    clientCodec = exactMatch;
                }
            }

            let alternativePayloadType: number;
            switch (codecName.toLowerCase()) {
                case "opus":
                    alternativePayloadType = 111;
                    break;
                case "h264":
                    alternativePayloadType = 109;
                    break;
                default:
                    alternativePayloadType = 96;
            }

            supportedCodecs.push({
                ...codec,
                parameters: {
                    ...codec.parameters,
                    "profile-level-id": (clientCodec as any)?.parameters?.["profile-level-id"] ?? codec.parameters?.["profile-level-id"],
                },
                preferredPayloadType: clientCodec?.payload_type ?? alternativePayloadType,
            });
        }

        // 2. Add RTX codecs matching the video codecs we just added
        /* 
        // RTX disabled to prevent Mediasoup crash (unsupported codec) and packet loss issues.
        // The installed mediasoup version's supportedRtpCapabilities does not list video/rtx.
        const videoCodecs = supportedCodecs.filter(c => c.kind === "video");
        for (const videoCodec of videoCodecs) {
            // Find RTX in client offer that points to this video codec (via apt)
            const clientRtx = codecs.find(c => 
                c.name.toUpperCase() === "RTX" && 
                Number((c as any).parameters?.apt) === videoCodec.preferredPayloadType
            );
            
            if (clientRtx) {
                supportedCodecs.push({
                    kind: 'video',
                    mimeType: 'video/rtx',
                    clockRate: videoCodec.clockRate,
                    parameters: {
                        apt: videoCodec.preferredPayloadType
                    },
                    preferredPayloadType: clientRtx.payload_type,
                    rtcpFeedback: [
                        { type: "nack" },
                        { type: "nack", parameter: "pli" },
                        { type: "ccm", parameter: "fir" },
                        { type: "goog-remb" },
                    ]
                });
            }
        }
        */

        console.log("[VoiceRoom] Configured codecs:", supportedCodecs.map((c) => ({ mime: c.mimeType, pt: c.preferredPayloadType, apt: c.parameters?.apt })));
        client.codecCapabilities = supportedCodecs;
    };

    onClientLeave = (client: MediasoupWebRtcClient) => {
        console.log("stopping client");
        this._clients.delete(client.roomClientKey ?? client.user_id);
        if (this._type === "stream" && this._clients.size === 0) {
            this.stopKeyframeInterval();
        }

        // stop the client
        if (!client.isStopped) {
            client.isStopped = true;

            for (const otherClient of this.clients.values()) {
                if (otherClient.user_id === client.user_id) continue;

                // close any consumers of closing client producers
                otherClient.consumers?.forEach((consumer) => {
                    if (
                        client?.audioProducer?.id === consumer.producerId ||
                        client?.videoProducer?.id === consumer.producerId
                    ) {
                        console.log("[WebRTC] closing consumer", consumer.id);
                        consumer.close();
                    }
                });
            }

            client.consumers?.forEach((consumer) => consumer.close());
            client.audioProducer?.close();
            client.videoProducer?.close();

            client.transport?.close();
            client.room = undefined;
            client.audioProducer = undefined;
            client.videoProducer = undefined;
            client.consumers = [];
            client.transport = undefined;
            client.websocket = undefined;
            client.emitter.removeAllListeners();
        }
    };

    get clients(): Map<string, MediasoupWebRtcClient> {
        return this._clients;
    }

    getClientById = (id: string, preferProducing?: "audio" | "video") => {
        if (!preferProducing) {
            return this._clients.get(id) ?? Array.from(this._clients.values()).find((c) => c.user_id === id);
        }
        let fallback: MediasoupWebRtcClient | undefined;
        for (const c of this._clients.values()) {
            if (c.user_id !== id) continue;
            fallback = c;
            if (preferProducing === "video" && c.isProducingVideo()) return c;
            if (preferProducing === "audio" && c.isProducingAudio()) return c;
        }
        return fallback;
    };

    get id(): string {
        return this._id;
    }

    get type(): "guild-voice" | "dm-voice" | "stream" {
        return this._type;
    }

    get router(): RouterType {
        return this._router;
    }

    private startKeyframeIntervalIfNeeded(): void {
        if (this._keyframeIntervalId != null) return;
        this._keyframeIntervalId = setInterval(() => {
            for (const viewer of this._clients.values()) {
                if (viewer.isStopped || !viewer.consumers?.length) continue;
                for (const consumer of viewer.consumers) {
                    if (consumer.closed || (consumer.appData?.type as string) !== "video") continue;
                    const producerUserId = consumer.appData?.user_id as string | undefined;
                    if (!producerUserId) continue;
                    viewer.requestKeyFrame(producerUserId).catch((err) => {
                        console.warn("[VoiceRoom] keyframe request failed:", err);
                    });
                }
            }
        }, STREAM_KEYFRAME_INTERVAL_MS);
        console.log("[VoiceRoom] Started periodic keyframe requests for stream room", this._id, "every", STREAM_KEYFRAME_INTERVAL_MS, "ms");
    }

    private stopKeyframeInterval(): void {
        if (this._keyframeIntervalId != null) {
            clearInterval(this._keyframeIntervalId);
            this._keyframeIntervalId = null;
            console.log("[VoiceRoom] Stopped keyframe interval for stream room", this._id);
        }
    }
}
