import type {
    ClientEmitter,
    Codec,
    RtpHeader,
    SSRCs,
    VideoStream,
    WebRtcClient,
} from "@spacebarchat/spacebar-webrtc-types";
import { VoiceRoom } from "./VoiceRoom.js";
import { EventEmitter } from "node:events";
import type { types as MediasoupTypes } from "mediasoup";

type Consumer = MediasoupTypes.Consumer;
type Producer = MediasoupTypes.Producer;
type RtpCodecCapability = MediasoupTypes.RtpCodecCapability;
type RtpCodecParameters = MediasoupTypes.RtpCodecParameters;
type RtpHeaderExtension = MediasoupTypes.RtpHeaderExtension;
type RtpHeaderExtensionUri = MediasoupTypes.RtpHeaderExtensionUri;
type Transport = MediasoupTypes.Transport;

export class MediasoupWebRtcClient implements WebRtcClient<any> {
    videoStream?: VideoStream | undefined;
    websocket: any;
    user_id: string;
    voiceRoomId: string;
    webrtcConnected: boolean;
    emitter: ClientEmitter;

    public room?: VoiceRoom;
    public isStopped?: boolean;
    public transport?: Transport;
    public codecs?: Codec[];
    public codecCapabilities?: RtpCodecCapability[];
    public headerExtensions?: RtpHeader[];
    public audioProducer?: Producer;
    public videoProducer?: Producer;
    public consumers?: Consumer[];
    public incomingSSRCS?: SSRCs;

    constructor(
        userId: string,
        roomId: string,
        websocket: any,
        room: VoiceRoom
    ) {
        this.user_id = userId;
        this.voiceRoomId = roomId;
        this.websocket = websocket;
        this.room = room;
        this.webrtcConnected = false;
        this.isStopped = false;
        this.emitter = new EventEmitter();
        this.consumers = [];
    }

    initIncomingSSRCs(ssrcs: SSRCs): void {
        this.incomingSSRCS = ssrcs;
    }

    getIncomingStreamSSRCs(): SSRCs {
        return {
            audio_ssrc: this.incomingSSRCS?.audio_ssrc,
            video_ssrc: this.isProducingVideo()
                ? this.incomingSSRCS?.video_ssrc
                : 0,
            rtx_ssrc: this.isProducingVideo()
                ? this.incomingSSRCS?.rtx_ssrc
                : 0,
        };
    }

    getOutgoingStreamSSRCsForUser(user_id: string): SSRCs {
        const otherClient = this.room?.getClientById(user_id);

        if (!otherClient) {
            return {};
        }

        const audioProducerId = otherClient.audioProducer?.id;
        const videoProducerId = otherClient.videoProducer?.id;

        const audioConsumer = this.consumers?.find(
            (consumer) => consumer.producerId === audioProducerId
        );
        const videoConsumer = this.consumers?.find(
            (consumer) => consumer.producerId === videoProducerId
        );

        return {
            audio_ssrc: audioConsumer?.rtpParameters.encodings?.find(
                (encoding): encoding is MediasoupTypes.RtpEncodingParameters => encoding !== undefined
            )?.ssrc,
            video_ssrc: videoConsumer?.rtpParameters.encodings?.find(
                (encoding): encoding is MediasoupTypes.RtpEncodingParameters => encoding !== undefined
            )?.ssrc,
            rtx_ssrc: videoConsumer?.rtpParameters.encodings?.find(
                (encoding): encoding is MediasoupTypes.RtpEncodingParameters => encoding !== undefined
            )?.rtx?.ssrc,
        };
    }

    isProducingAudio(): boolean {
        return !!this.audioProducer;
    }

    isProducingVideo(): boolean {
        return !!this.videoProducer;
    }

    async publishTrack(type: "audio" | "video", ssrc: SSRCs): Promise<void> {
        if (!this.webrtcConnected || !this.transport) return;

        if (type === "audio" && !this.isProducingAudio()) {
            const audioCodec = this.codecCapabilities?.find((codec) => codec.kind === "audio");

            this.audioProducer = await this.transport.produce({
                kind: "audio",
                rtpParameters: {
                    codecs: audioCodec
                        ? [
                              {
                                  mimeType: audioCodec.mimeType,
                                  clockRate: audioCodec.clockRate,
                                  channels: audioCodec.channels,
                                  rtcpFeedback: audioCodec.rtcpFeedback,
                                  parameters: audioCodec.parameters ?? {},
                                  payloadType: audioCodec.preferredPayloadType ?? 111,
                              },
                          ]
                        : [],
                    encodings: [
                        {
                            ssrc: ssrc.audio_ssrc,
                            maxBitrate: 64000,
                            codecPayloadType: audioCodec?.preferredPayloadType ?? 111,
                        },
                    ],
                    headerExtensions: this.headerExtensions
                        ?.filter(
                            (header) =>
                                header.uri === "urn:ietf:params:rtp-hdrext:ssrc-audio-level" ||
                                header.uri === "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01"
                        )
                        .map((header) => {
                            return {
                                id: header.id,
                                uri: header.uri as RtpHeaderExtensionUri,
                            };
                        }),
                },
                paused: false,
            });

            // Store audio SSRC
            this.incomingSSRCS = {
                ...this.incomingSSRCS,
                audio_ssrc: ssrc.audio_ssrc,
            };
        }

        if (type === "video" && !this.isProducingVideo()) {
            // Get the main video codec (H264) and RTX codec
            const videoCodecs = this.codecCapabilities?.filter((codec) => codec.kind === "video") ?? [];
            const mainVideoCodec = videoCodecs.find((codec) => !codec.mimeType.toLowerCase().includes("rtx"));
            const rtxCodec = videoCodecs.find((codec) => codec.mimeType.toLowerCase().includes("rtx"));

            const codecs: RtpCodecParameters[] = [];

            // Add main video codec (H264)
            if (mainVideoCodec) {
                codecs.push({
                    mimeType: mainVideoCodec.mimeType,
                    clockRate: mainVideoCodec.clockRate,
                    channels: mainVideoCodec.channels,
                    rtcpFeedback: mainVideoCodec.rtcpFeedback,
                    parameters: mainVideoCodec.parameters ?? {},
                    payloadType: mainVideoCodec.preferredPayloadType ?? 102,
                });
            }

            // Add RTX codec for retransmission
            if (rtxCodec) {
                codecs.push({
                    mimeType: rtxCodec.mimeType,
                    clockRate: rtxCodec.clockRate,
                    rtcpFeedback: rtxCodec.rtcpFeedback ?? [],
                    parameters: rtxCodec.parameters ?? { apt: mainVideoCodec?.preferredPayloadType ?? 102 },
                    payloadType: rtxCodec.preferredPayloadType ?? 103,
                });
            }

            this.videoProducer = await this.transport.produce({
                kind: "video",
                rtpParameters: {
                    codecs,
                    encodings: [
                        {
                            ssrc: ssrc.video_ssrc,
                            rtx: ssrc.rtx_ssrc ? { ssrc: ssrc.rtx_ssrc } : undefined,
                            maxBitrate: 2500000,
                            codecPayloadType: mainVideoCodec?.preferredPayloadType ?? 102,
                        },
                    ],
                    headerExtensions: this.headerExtensions
                        ?.filter(
                            (header) =>
                                header.uri === "http://www.webrtc.org/experiments/rtp-hdrext/playout-delay" ||
                                header.uri === "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time" ||
                                header.uri === "urn:ietf:params:rtp-hdrext:toffset" ||
                                header.uri === "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01" ||
                                header.uri === "urn:3gpp:video-orientation"
                        )
                        .map((header) => {
                            return {
                                id: header.id,
                                uri: header.uri as RtpHeaderExtensionUri,
                            };
                        }),
                },
                paused: false,
            });

            // Store video SSRCs
            this.incomingSSRCS = {
                ...this.incomingSSRCS,
                video_ssrc: ssrc.video_ssrc,
                rtx_ssrc: ssrc.rtx_ssrc,
            };
        }
    }

    stopPublishingTrack(type: "audio" | "video"): void {
        if (!this.room) return;

        const producer =
            type === "audio" ? this.audioProducer : this.videoProducer;

        for (const client of this.room.clients.values()) {
            const consumers = client.consumers?.filter(
                (consumer) => consumer.producerId === producer?.id
            );

            consumers?.forEach((consumer) => {
                consumer.close();
                const index = client.consumers?.indexOf(consumer);
                if (typeof index === "number" && index != -1)
                    client.consumers?.splice(index, 1);
            });
        }

        // close the existing producer, if any
        producer?.close();

        if (type === "audio") this.audioProducer = undefined;
        else this.videoProducer = undefined;
    }

    async subscribeToTrack(
        user_id: string,
        type: "audio" | "video"
    ): Promise<void> {
        if (!this.webrtcConnected || !this.transport) return;

        const client = this.room?.getClientById(user_id);

        if (!client) return;

        const producer =
            type === "audio" ? client.audioProducer : client.videoProducer;

        if (!producer) return;

        let existingConsumer = this.consumers?.find(
            (x) => x.producerId === producer?.id
        );

        if (existingConsumer) return;

        // Filter header extensions for the specific media type
        const headerExtensions = this.headerExtensions
            ?.filter((header) => {
                if (type === "audio") {
                    return (
                        header.uri === "urn:ietf:params:rtp-hdrext:ssrc-audio-level" ||
                        header.uri === "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01"
                    );
                } else {
                    return (
                        header.uri === "http://www.webrtc.org/experiments/rtp-hdrext/playout-delay" ||
                        header.uri === "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time" ||
                        header.uri === "urn:ietf:params:rtp-hdrext:toffset" ||
                        header.uri === "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01" ||
                        header.uri === "urn:3gpp:video-orientation"
                    );
                }
            })
            .map((header) => {
                return {
                    preferredId: header.id,
                    uri: header.uri as RtpHeaderExtensionUri,
                    kind: type,
                };
            }) ?? [];

        // Filter codecs for the specific media type
        const codecs = this.codecCapabilities?.filter((codec) => codec.kind === type) ?? [];

        const consumer = await this.transport.consume({
            producerId: producer.id,
            rtpCapabilities: {
                codecs,
                headerExtensions,
            },
            paused: type === "video",
            appData: {
                user_id: client.user_id,
                type,
            },
        });

        if (type === "video") {
            // Resume video after a short delay to allow setup
            setTimeout(async () => {
                try {
                    await consumer.resume();
                } catch (error) {
                    console.error("Failed to resume video consumer:", error);
                }
            }, 1000);
        }

        this.consumers?.push(consumer);
    }

    unSubscribeFromTrack(user_id: string, type: "audio" | "video"): void {
        const client = this.room?.getClientById(user_id);

        if (!client) return;

        const producer =
            type === "audio" ? client.audioProducer : client.videoProducer;

        if (!producer) return;

        const consumer = this.consumers?.find(
            (c) => c.producerId === producer.id
        );

        if (!consumer) return;

        consumer.close();
        const index = this.consumers?.indexOf(consumer);
        if (typeof index === "number" && index != -1)
            this.consumers?.splice(index, 1);
    }

    isSubscribedToTrack(user_id: string, type: "audio" | "video"): boolean {
        const client = this.room?.getClientById(user_id);

        if (!client) return false;

        const producer =
            type === "audio" ? client.audioProducer : client.videoProducer;

        if (!producer) return false;

        const consumer = this.consumers?.find(
            (c) => c.producerId === producer.id
        );

        if (consumer) return true;

        return false;
    }
}
