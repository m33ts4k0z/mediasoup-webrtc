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
type RtpCapabilities = MediasoupTypes.RtpCapabilities;
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
    public clientRtpCapabilities?: RtpCapabilities;
    public headerExtensions?: RtpHeader[];
    public audioProducer?: Producer;
    public videoProducer?: Producer;
    public consumers?: Consumer[];
    public incomingSSRCS?: SSRCs;
    /** For stream rooms: unique per connection so streamer + viewer (same user) can coexist */
    public sessionId?: string;
    /** Key used in room's client map (set by VoiceRoom.onClientJoin) */
    public roomClientKey?: string;

    /** Guards against concurrent publishTrack("audio") producing the same SSRC. */
    private audioPublishInProgress: Promise<void> | null = null;
    /** Guards against concurrent publishTrack("video") producing the same SSRC. */
    private videoPublishInProgress: Promise<void> | null = null;

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
        const otherClient = this.room?.getClientById(user_id, "video") ?? this.room?.getClientById(user_id);

        if (!otherClient) {
            console.log("[mediasoup] getOutgoingStreamSSRCsForUser: client not found", user_id);
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

        if (!videoConsumer && videoProducerId) {
             console.log("[mediasoup] getOutgoingStreamSSRCsForUser: video consumer not found. producerId:", videoProducerId, "my consumers:", this.consumers?.map(c => c.producerId));
        }

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

    /**
     * Get the video codec payload types from the consumer for a specific user.
     * This is needed so the client can build an SDP with matching payload types.
     */
    getOutgoingStreamCodecsForUser(user_id: string): { video_pt?: number; rtx_pt?: number; audio_pt?: number } {
        const otherClient = this.room?.getClientById(user_id, "video") ?? this.room?.getClientById(user_id);

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

        // Get the main video codec (non-RTX)
        const videoCodec = videoConsumer?.rtpParameters.codecs?.find(
            (c) => !c.mimeType.toLowerCase().includes("rtx")
        );
        // Get the RTX codec
        const rtxCodec = videoConsumer?.rtpParameters.codecs?.find(
            (c) => c.mimeType.toLowerCase().includes("rtx")
        );
        // Get the audio codec
        const audioCodec = audioConsumer?.rtpParameters.codecs?.[0];

        return {
            video_pt: videoCodec?.payloadType,
            rtx_pt: rtxCodec?.payloadType,
            audio_pt: audioCodec?.payloadType,
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
            if (this.audioPublishInProgress) {
                await this.audioPublishInProgress;
                if (this.isProducingAudio()) return;
            }
            const doPublish = async () => {
                const audioCodec = this.codecCapabilities?.find((codec) => codec.kind === "audio");

                this.audioProducer = await this.transport!.produce({
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

                this.incomingSSRCS = {
                    ...this.incomingSSRCS,
                    audio_ssrc: ssrc.audio_ssrc,
                };
            };
            this.audioPublishInProgress = doPublish().finally(() => {
                this.audioPublishInProgress = null;
            });
            await this.audioPublishInProgress;
        }

        if (type === "video" && !this.isProducingVideo()) {
            if (this.videoPublishInProgress) {
                await this.videoPublishInProgress;
                if (this.isProducingVideo()) return;
            }
            const doPublish = async () => {
                const videoCodecs = this.codecCapabilities?.filter((codec) => codec.kind === "video") ?? [];
                // Prefer any H264, else non-RTX
                const mainVideoCodec = videoCodecs.find((codec) => codec.mimeType.toLowerCase().includes("h264"))
                    ?? videoCodecs.find((codec) => !codec.mimeType.toLowerCase().includes("rtx"));
                const rtxCodec = mainVideoCodec
                    ? videoCodecs.find((codec) => codec.mimeType.toLowerCase().includes("rtx") && codec.parameters?.apt == mainVideoCodec.preferredPayloadType)
                    : undefined;

                const codecs: RtpCodecParameters[] = [];

                if (mainVideoCodec) {
                    codecs.push({
                        mimeType: mainVideoCodec.mimeType,
                        clockRate: mainVideoCodec.clockRate,
                        channels: mainVideoCodec.channels,
                        rtcpFeedback: mainVideoCodec.rtcpFeedback,
                        parameters: mainVideoCodec.parameters ?? {},
                        payloadType: mainVideoCodec.preferredPayloadType ?? 109,
                    });
                }

                if (rtxCodec) {
                    codecs.push({
                        mimeType: rtxCodec.mimeType,
                        clockRate: rtxCodec.clockRate,
                        rtcpFeedback: rtxCodec.rtcpFeedback ?? [],
                        parameters: rtxCodec.parameters ?? { apt: mainVideoCodec?.preferredPayloadType ?? 109 },
                        payloadType: rtxCodec.preferredPayloadType ?? 114, // RTX for H264 109
                    });
                }

                console.log("[mediasoup] Creating video producer with ssrc:", ssrc.video_ssrc, "rtx:", ssrc.rtx_ssrc);
                // #region agent log
                fetch('http://127.0.0.1:7242/ingest/043f8e22-2b34-44f1-b19b-fc11dd5647b1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'MediasoupWebRtcClient.ts:publishTrack-videoProducer',message:'Creating video producer',data:{user_id:this.user_id,video_ssrc:ssrc.video_ssrc,rtx_ssrc:ssrc.rtx_ssrc,codecsCount:codecs.length,mainCodec:mainVideoCodec?.mimeType,rtxCodec:rtxCodec?.mimeType},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H5'})}).catch(()=>{});
                // #endregion
                
                const videoHeaderExts = (this.headerExtensions ?? [])
                    .filter(
                        (header) =>
                            header.uri === "http://www.webrtc.org/experiments/rtp-hdrext/playout-delay" ||
                            header.uri === "http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time" ||
                            header.uri === "urn:ietf:params:rtp-hdrext:toffset" ||
                            header.uri === "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01" ||
                            header.uri === "urn:3gpp:video-orientation" ||
                            header.uri === "urn:ietf:params:rtp-hdrext:sdes:mid" ||
                            header.uri === "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id" ||
                            header.uri === "urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id"
                    )
                    .map((header) => ({
                        id: header.id,
                        uri: header.uri as RtpHeaderExtensionUri,
                    }));
                const midUri = "urn:ietf:params:rtp-hdrext:sdes:mid" as RtpHeaderExtensionUri;
                if (!videoHeaderExts.some((h) => h.uri === midUri)) {
                    videoHeaderExts.unshift({ id: 4, uri: midUri });
                }
                this.videoProducer = await this.transport!.produce({
                    kind: "video",
                    rtpParameters: {
                        codecs,
                        encodings: [
                            {
                                ssrc: ssrc.video_ssrc,
                                rtx: (ssrc.rtx_ssrc && rtxCodec) ? { ssrc: ssrc.rtx_ssrc } : undefined,
                                maxBitrate: 2500000,
                                codecPayloadType: mainVideoCodec?.preferredPayloadType ?? 109,
                            },
                        ],
                        headerExtensions: videoHeaderExts,
                    },
                    paused: false,
                });

                console.log("[mediasoup] Video producer created:", this.videoProducer.id, "paused:", this.videoProducer.paused, "expected SSRC:", ssrc.video_ssrc);
                // #region agent log
                const producerEncodings = this.videoProducer.rtpParameters?.encodings?.map(e => ({ ssrc: e.ssrc, rtx: e.rtx?.ssrc })) || [];
                fetch('http://127.0.0.1:7242/ingest/043f8e22-2b34-44f1-b19b-fc11dd5647b1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'MediasoupWebRtcClient.ts:publishTrack-videoProducerCreated',message:'Video producer created - SSRC expected',data:{user_id:this.user_id,producerId:this.videoProducer.id,paused:this.videoProducer.paused,kind:this.videoProducer.kind,expectedSsrc:ssrc.video_ssrc,expectedRtxSsrc:ssrc.rtx_ssrc,producerEncodings},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H5'})}).catch(()=>{});
                // #endregion

                // Monitor producer stats after creation to verify it's receiving RTP
                const producerId = this.videoProducer.id;
                setTimeout(async () => {
                    if (this.videoProducer?.id === producerId && !this.videoProducer?.closed) {
                        try {
                            const stats = await this.videoProducer.getStats();
                            const producerStats = stats.length > 0 ? {
                                byteCount: stats[0].byteCount,
                                packetCount: stats[0].packetCount,
                                score: stats[0].score,
                                type: stats[0].type
                            } : null;
                            // Also get transport stats to see total incoming bytes
                            let transportStats = null;
                            if (this.transport && !this.transport.closed) {
                                try {
                                    const tStats = await this.transport.getStats();
                                    const firstStat = tStats[0] as any;
                                    transportStats = {
                                        bytesReceived: firstStat?.bytesReceived,
                                        rtpBytesReceived: firstStat?.rtpBytesReceived,
                                        rtpPacketsReceived: firstStat?.rtpPacketsReceived,
                                        iceState: firstStat?.iceState,
                                        dtlsState: firstStat?.dtlsState,
                                    };
                                } catch (e) { /* ignore */ }
                            }
                            // #region agent log
                            fetch('http://127.0.0.1:7242/ingest/043f8e22-2b34-44f1-b19b-fc11dd5647b1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'MediasoupWebRtcClient.ts:publishTrack-producerStats500ms',message:'Producer stats at 500ms',data:{user_id:this.user_id,producerId:this.videoProducer.id,paused:this.videoProducer.paused,stats:producerStats,transportStats},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H5'})}).catch(()=>{});
                            // #endregion
                        } catch (e) { /* ignore */ }
                    }
                }, 500);

                setTimeout(async () => {
                    if (this.videoProducer?.id === producerId && !this.videoProducer?.closed) {
                        try {
                            const stats = await this.videoProducer.getStats();
                            const producerStats = stats.length > 0 ? {
                                byteCount: stats[0].byteCount,
                                packetCount: stats[0].packetCount,
                                score: stats[0].score,
                                type: stats[0].type
                            } : null;
                            // Also get transport stats
                            let transportStats = null;
                            if (this.transport && !this.transport.closed) {
                                try {
                                    const tStats = await this.transport.getStats();
                                    const firstStat = tStats[0] as any;
                                    transportStats = {
                                        bytesReceived: firstStat?.bytesReceived,
                                        rtpBytesReceived: firstStat?.rtpBytesReceived,
                                        rtpPacketsReceived: firstStat?.rtpPacketsReceived,
                                        iceState: firstStat?.iceState,
                                        dtlsState: firstStat?.dtlsState,
                                    };
                                } catch (e) { /* ignore */ }
                            }
                            // #region agent log
                            fetch('http://127.0.0.1:7242/ingest/043f8e22-2b34-44f1-b19b-fc11dd5647b1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'MediasoupWebRtcClient.ts:publishTrack-producerStats2000ms',message:'Producer stats at 2000ms',data:{user_id:this.user_id,producerId:this.videoProducer.id,paused:this.videoProducer.paused,stats:producerStats,transportStats},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H5'})}).catch(()=>{});
                            // #endregion
                        } catch (e) { /* ignore */ }
                    }
                }, 2000);

                this.incomingSSRCS = {
                    ...this.incomingSSRCS,
                    video_ssrc: ssrc.video_ssrc,
                    rtx_ssrc: ssrc.rtx_ssrc,
                };
            };
            this.videoPublishInProgress = doPublish().finally(() => {
                this.videoPublishInProgress = null;
            });
            await this.videoPublishInProgress;
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

    /** After creating a video consumer, SSRCs/codecs are stored here so op12 can use them (avoids lookup issues). */
    lastCreatedVideoConsumerSsrcs?: { ssrcs: { video_ssrc?: number; rtx_ssrc?: number }; codecs: { video_pt?: number; rtx_pt?: number } };

    /**
     * Create consumers for all existing producers in the room (other clients).
     * Call this from onOffer before building the answer so the answer SDP can include consumer SSRCs.
     */
    async subscribeToExistingProducersInRoom(): Promise<void> {
        if (!this.room || !this.transport) return;
        const videoOnly = this.room.type === "stream";
        for (const other of this.room.clients.values()) {
            if (other.roomClientKey === this.roomClientKey) continue;
            if (other.videoProducer) await this.subscribeToTrack(other.user_id, "video");
            if (!videoOnly && other.audioProducer) await this.subscribeToTrack(other.user_id, "audio");
        }
    }

    async subscribeToTrack(
        user_id: string,
        type: "audio" | "video"
    ): Promise<void> {
        this.lastCreatedVideoConsumerSsrcs = undefined;
        if (!this.transport) {
            if (type === "video") {
                console.log("[mediasoup] subscribeToTrack video skipped: no transport");
                // #region agent log
                fetch('http://127.0.0.1:7242/ingest/043f8e22-2b34-44f1-b19b-fc11dd5647b1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'MediasoupWebRtcClient.ts:subscribeToTrack-noTransport',message:'subscribeToTrack skipped: not connected',data:{viewer:this.user_id,producer:user_id,type,webrtcConnected:this.webrtcConnected,hasTransport:!!this.transport},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H3'})}).catch(()=>{});
                // #endregion
            }
            return;
        }

        const client = this.room?.getClientById(user_id, type) ?? this.room?.getClientById(user_id);

        if (!client) {
            if (type === "video") {
                console.log("[mediasoup] subscribeToTrack video skipped: no client for", user_id);
                // #region agent log
                fetch('http://127.0.0.1:7242/ingest/043f8e22-2b34-44f1-b19b-fc11dd5647b1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'MediasoupWebRtcClient.ts:subscribeToTrack-noClient',message:'subscribeToTrack skipped: no client',data:{viewer:this.user_id,producer:user_id,type},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H3'})}).catch(()=>{});
                // #endregion
            }
            return;
        }

        const producer =
            type === "audio" ? client.audioProducer : client.videoProducer;

        if (!producer) {
            if (type === "video") {
                console.log("[mediasoup] subscribeToTrack video skipped: no videoProducer for", user_id);
                // #region agent log
                fetch('http://127.0.0.1:7242/ingest/043f8e22-2b34-44f1-b19b-fc11dd5647b1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'MediasoupWebRtcClient.ts:subscribeToTrack-noProducer',message:'subscribeToTrack skipped: no producer',data:{viewer:this.user_id,producer:user_id,type,hasAudioProducer:!!client.audioProducer,hasVideoProducer:!!client.videoProducer},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H3'})}).catch(()=>{});
                // #endregion
            }
            return;
        }

        let existingConsumer = this.consumers?.find(
            (x) => x.producerId === producer?.id
        );

        if (existingConsumer) return;

        // Use the ROUTER's rtpCapabilities for header extensions (mediasoup best practice).
        // This ensures header extensions are properly matched during consume().
        // Our custom headerExtensions were being rejected by mediasoup, resulting in empty consumerHeaderExtensions.
        const routerCaps = this.room?.router.router.rtpCapabilities;
        let headerExtensions: RtpHeaderExtension[] = (routerCaps?.headerExtensions ?? [])
            .filter((ext) => ext.kind === type)
            .map((ext) => ({
                kind: ext.kind,
                uri: ext.uri,
                preferredId: ext.preferredId,
                preferredEncrypt: ext.preferredEncrypt,
                direction: ext.direction,
            }));

        // Fallback: if router has no header extensions for this type, use minimal MID extension
        if (type === "video" && headerExtensions.length === 0) {
            headerExtensions = [
                {
                    kind: "video" as const,
                    uri: "urn:ietf:params:rtp-hdrext:sdes:mid" as RtpHeaderExtensionUri,
                    preferredId: 4,
                },
            ];
        }

        // Filter codecs for the specific media type
        let codecs = this.codecCapabilities?.filter((codec) => codec.kind === type) ?? [];
        
        if (type === "video") {
            // Get the producer's main (non-RTX) codec
            const producerCodec = producer.rtpParameters.codecs.find(
                (c) => !c.mimeType.toLowerCase().includes("rtx")
            );
            
            console.log("[mediasoup] Producer codecs for consumer:", {
                producerCodec: producerCodec ? { mimeType: producerCodec.mimeType, payloadType: producerCodec.payloadType } : null,
                producerEncodings: producer.rtpParameters.encodings,
            });
            
            // Find matching codec in our capabilities (same mimeType as producer)
            const mainVideoCodec = codecs.find((c) => 
                !c.mimeType.toLowerCase().includes("rtx") && 
                c.mimeType.toLowerCase() === producerCodec?.mimeType.toLowerCase()
            ) || codecs.find((c) => !c.mimeType.toLowerCase().includes("rtx"));
            
            if (mainVideoCodec && producerCodec) {
                codecs = [{
                    kind: 'video',
                    mimeType: producerCodec.mimeType,
                    clockRate: producerCodec.clockRate,
                    preferredPayloadType: producerCodec.payloadType,
                    parameters: producerCodec.parameters ?? {},
                    rtcpFeedback: mainVideoCodec.rtcpFeedback ?? [],
                }];
                
                // Add RTX if available in capabilities and matches producer PT
                const rtxCap = this.codecCapabilities?.find(c => 
                    c.mimeType.toLowerCase() === "video/rtx" && 
                    Number(c.parameters?.apt) === producerCodec.payloadType
                );
                
                if (rtxCap) {
                    codecs.push({
                        kind: 'video',
                        mimeType: 'video/rtx',
                        clockRate: rtxCap.clockRate,
                        preferredPayloadType: rtxCap.preferredPayloadType,
                        parameters: rtxCap.parameters,
                        rtcpFeedback: rtxCap.rtcpFeedback ?? [],
                    });
                }
                
                console.log("[mediasoup] Consumer rtpCapabilities codecs:", codecs.map(c => ({
                    mimeType: c.mimeType,
                    pt: c.preferredPayloadType,
                    apt: c.parameters?.apt
                })));
            }
        }
        
        if (codecs.length === 0) {
            console.error(`[mediasoup] subscribeToTrack: No matching codecs found for ${type} from producer ${user_id}`);
            return;
        }

        // #region agent log
        if (type === "video") {
            fetch('http://127.0.0.1:7242/ingest/043f8e22-2b34-44f1-b19b-fc11dd5647b1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'MediasoupWebRtcClient.ts:subscribeToTrack-beforeConsume',message:'About to call transport.consume() for video',data:{viewer:this.user_id,producer:client.user_id,producerId:producer.id,producerHeaderExtensions:producer.rtpParameters.headerExtensions,consumerRtpCapabilities:{codecs:codecs.map(c=>({mimeType:c.mimeType,pt:c.preferredPayloadType})),headerExtensions:headerExtensions}},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H50'})}).catch(()=>{});
        }
        // #endregion
        // Create video consumer UNPAUSED so RTP flows immediately to the viewer.
        // Previously we created it paused and resumed on VIEWER_READY; that led to 0 bytes
        // (resume timing or mediasoup behavior). Unpaused ensures RTP flows as soon as
        // the viewer's receiver is ready after setRemoteDescription.
        const consumer = await this.transport.consume({
            producerId: producer.id,
            rtpCapabilities: {
                codecs,
                headerExtensions,
            },
            paused: false,
            appData: {
                user_id: client.user_id,
                type,
            },
        });

        if (type === "video") {
            const encoding = consumer.rtpParameters.encodings?.[0];
            const consumerCodecs = consumer.rtpParameters.codecs ?? [];
            const producerCodec = producer.rtpParameters.codecs?.[0];
            const consumerHeaderExts = consumer.rtpParameters.headerExtensions?.map(h => h.uri) ?? [];
            const consumerPtLog = consumerCodecs.map(c => `${c.mimeType}:${c.payloadType}`).join(", ");
            console.log("[mediasoup] video consumer created for viewer", this.user_id, 
                "from producer", client.user_id, 
                "consumerId", consumer.id, 
                "paused:", consumer.paused,
                "ssrc:", encoding?.ssrc,
                "rtx:", encoding?.rtx?.ssrc,
                "codecs:", consumerPtLog,
                "producerPaused:", consumer.producerPaused,
                "headerExts:", consumerHeaderExts
            );

            // #region agent log
            try {
                const tStats: any[] = this.transport && !this.transport.closed ? (await this.transport.getStats() as any) : [];
                const cStats: any[] = !consumer.closed ? (await consumer.getStats() as any) : [];
                fetch('http://127.0.0.1:7242/ingest/043f8e22-2b34-44f1-b19b-fc11dd5647b1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'MediasoupWebRtcClient.ts:subscribeToTrack-afterConsumeStats',message:'viewer transport+consumer stats right after consume()',data:{viewer:this.user_id,producer:client.user_id,transportId:this.transport?.id,transportClosed:this.transport?.closed,transportStats:tStats,consumerId:consumer.id,consumerClosed:consumer.closed,consumerStats:cStats,consumerRtpParameters:consumer.rtpParameters},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1'})}).catch(()=>{});
            } catch (e) {
                fetch('http://127.0.0.1:7242/ingest/043f8e22-2b34-44f1-b19b-fc11dd5647b1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'MediasoupWebRtcClient.ts:subscribeToTrack-afterConsumeStats',message:'FAILED to read transport/consumer stats after consume()',data:{viewer:this.user_id,producer:client.user_id,error:String(e)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1'})}).catch(()=>{});
            }
            // #endregion

            // #region agent log
            const consumerCodec = consumerCodecs[0];
            fetch('http://127.0.0.1:7242/ingest/043f8e22-2b34-44f1-b19b-fc11dd5647b1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'MediasoupWebRtcClient.ts:subscribeToTrack-consumerCreated',message:'Video consumer created (UNPAUSED)',data:{viewer:this.user_id,producer:client.user_id,consumerId:consumer.id,consumerPaused:consumer.paused,producerPaused:consumer.producerPaused,ssrc:encoding?.ssrc,rtxSsrc:encoding?.rtx?.ssrc,consumerCodec:{mimeType:consumerCodec?.mimeType,payloadType:consumerCodec?.payloadType,parameters:consumerCodec?.parameters},producerCodec:{mimeType:producerCodec?.mimeType,payloadType:producerCodec?.payloadType,parameters:producerCodec?.parameters},consumerHeaderExtensions:consumerHeaderExts,requestedHeaderExtensions:headerExtensions.map(h=>h.uri)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H17'})}).catch(()=>{});
            // #endregion
            console.log("[mediasoup] video consumer created UNPAUSED - RTP will flow to viewer");

            this.consumers?.push(consumer);
            const videoCodec = consumerCodecs.find((c) => !c.mimeType.toLowerCase().includes("rtx"));
            const rtxCodec = consumerCodecs.find((c) => c.mimeType.toLowerCase().includes("rtx"));
            this.lastCreatedVideoConsumerSsrcs = {
                ssrcs: {
                    video_ssrc: encoding?.ssrc,
                    rtx_ssrc: (encoding as { rtx?: { ssrc?: number } })?.rtx?.ssrc,
                },
                codecs: {
                    video_pt: videoCodec?.payloadType,
                    rtx_pt: rtxCodec?.payloadType,
                },
            };

            // Stream room: request keyframe immediately and burst so the producer (browser) emits
            // a keyframe quickly; otherwise viewers may see one frame only after 30–60s (encoder default).
            if (this.room?.type === "stream") {
                const producerUserId = client.user_id;
                this.requestKeyFrame(producerUserId).catch((err) =>
                    console.warn("[mediasoup] immediate keyframe request failed:", err)
                );
                // Burst of PLI requests so browser encoder is more likely to respond quickly.
                setTimeout(() => {
                    if (!this.isStopped && !consumer.closed) {
                        this.requestKeyFrame(producerUserId).catch(() => {});
                    }
                }, 400);
                setTimeout(() => {
                    if (!this.isStopped && !consumer.closed) {
                        this.requestKeyFrame(producerUserId).catch(() => {});
                    }
                }, 800);
            }
        } else {
            this.consumers?.push(consumer);
        }
    }

    unSubscribeFromTrack(user_id: string, type: "audio" | "video"): void {
        const client = this.room?.getClientById(user_id, type) ?? this.room?.getClientById(user_id);

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
        const client = this.room?.getClientById(user_id, type) ?? this.room?.getClientById(user_id);

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

    /**
     * Resolve __pending_stream_producer__ to the actual producer user_id when the viewer
     * sent VIEWER_READY before op12 (real producer id) was applied. Uses the first video consumer.
     */
    getFirstVideoProducerUserId(): string | undefined {
        const videoConsumer = this.consumers?.find((c) => c.appData?.type === "video");
        return videoConsumer?.appData?.user_id as string | undefined;
    }

    /**
     * Request a keyframe for the video consumer receiving from a specific user.
     * Call this after the viewer's WebRTC connection has completed SDP negotiation
     * to ensure the viewer receives a fresh keyframe it can decode.
     */
    async requestKeyFrame(producer_user_id: string): Promise<boolean> {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/043f8e22-2b34-44f1-b19b-fc11dd5647b1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'MediasoupWebRtcClient.ts:requestKeyFrame-entry',message:'requestKeyFrame called',data:{viewer:this.user_id,producer:producer_user_id,consumerCount:this.consumers?.length,consumers:this.consumers?.map(c=>({id:c.id,appData:c.appData,paused:c.paused,producerPaused:c.producerPaused}))},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H3'})}).catch(()=>{});
        // #endregion

        // Client may send VIEWER_READY with __pending_stream_producer__ before op12; resolve to actual producer
        let resolvedProducerId = producer_user_id;
        if (producer_user_id === "__pending_stream_producer__") {
            const actual = this.getFirstVideoProducerUserId();
            if (actual) {
                resolvedProducerId = actual;
                console.log("[mediasoup] requestKeyFrame: resolved __pending_stream_producer__ to", resolvedProducerId);
            }
        }

        const videoConsumer = this.consumers?.find(
            (c) => c.appData?.user_id === resolvedProducerId && c.appData?.type === "video"
        );

        if (!videoConsumer) {
            console.log("[mediasoup] requestKeyFrame: no video consumer for producer", resolvedProducerId);
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/043f8e22-2b34-44f1-b19b-fc11dd5647b1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'MediasoupWebRtcClient.ts:requestKeyFrame-noConsumer',message:'requestKeyFrame: no video consumer found',data:{viewer:this.user_id,producer:producer_user_id,consumerCount:this.consumers?.length,allAppData:this.consumers?.map(c=>c.appData)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H3'})}).catch(()=>{});
            // #endregion
            return false;
        }

        // Don't call requestKeyFrame on a closed consumer (e.g. viewer disconnected already)
        if (videoConsumer.closed) {
            console.log("[mediasoup] requestKeyFrame: consumer already closed, skipping", videoConsumer.id);
            return false;
        }

        // Get the producer client to check producer stats
        const producerClient = this.room?.getClientById(resolvedProducerId, "video") ?? this.room?.getClientById(resolvedProducerId);
        const producer = producerClient?.videoProducer;

        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/043f8e22-2b34-44f1-b19b-fc11dd5647b1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'MediasoupWebRtcClient.ts:requestKeyFrame-foundConsumer',message:'Found video consumer',data:{viewer:this.user_id,producer:resolvedProducerId,consumerId:videoConsumer.id,consumerPaused:videoConsumer.paused,producerPaused:videoConsumer.producerPaused,consumerClosed:videoConsumer.closed,hasProducerClient:!!producerClient,hasProducer:!!producer,producerPausedDirect:producer?.paused,producerClosed:producer?.closed,producerKind:producer?.kind},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H15'})}).catch(()=>{});
        // #endregion

        try {
            // First, resume the consumer if it's paused
            // This ensures the consumer is ready to receive RTP before we request keyframe
            if (videoConsumer.paused) {
                await videoConsumer.resume();
                const enc = videoConsumer.rtpParameters.encodings?.[0];
                console.log("[mediasoup] requestKeyFrame: resumed paused consumer for viewer", this.user_id, "consumer SSRC:", enc?.ssrc, "rtx:", enc?.rtx?.ssrc);
                // #region agent log
                fetch('http://127.0.0.1:7242/ingest/043f8e22-2b34-44f1-b19b-fc11dd5647b1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'MediasoupWebRtcClient.ts:requestKeyFrame-resumed',message:'Consumer resumed before keyframe request',data:{viewer:this.user_id,producer:producer_user_id,consumerId:videoConsumer.id},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H13'})}).catch(()=>{});
                // #endregion
            }

            // Get producer stats before keyframe request
            let producerStatsBefore = null;
            if (producer && !producer.closed) {
                try {
                    const stats = await producer.getStats();
                    producerStatsBefore = stats.length > 0 ? { 
                        byteCount: stats[0].byteCount,
                        packetCount: stats[0].packetCount,
                        score: stats[0].score,
                        type: stats[0].type,
                    } : null;
                    console.log(`[mediasoup] requestKeyFrame: producer stats for ${producer_user_id}:`, producerStatsBefore);
                } catch (e) { /* ignore stats error */ }
            }

            // Get detailed producer RTP params
            const producerRtpParams = producer ? {
                codecs: producer.rtpParameters.codecs.map(c => ({
                    mimeType: c.mimeType,
                    payloadType: c.payloadType,
                    clockRate: c.clockRate,
                    parameters: c.parameters
                })),
                encodings: producer.rtpParameters.encodings,
                headerExtensions: producer.rtpParameters.headerExtensions?.map(h => ({
                    uri: h.uri,
                    id: h.id
                }))
            } : null;

            // Get detailed consumer RTP params
            const consumerRtpParams = {
                codecs: videoConsumer.rtpParameters.codecs.map(c => ({
                    mimeType: c.mimeType,
                    payloadType: c.payloadType,
                    clockRate: c.clockRate,
                    parameters: c.parameters
                })),
                encodings: videoConsumer.rtpParameters.encodings,
                headerExtensions: videoConsumer.rtpParameters.headerExtensions?.map(h => ({
                    uri: h.uri,
                    id: h.id
                }))
            };

            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/043f8e22-2b34-44f1-b19b-fc11dd5647b1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'MediasoupWebRtcClient.ts:requestKeyFrame-rtpParams',message:'Producer vs Consumer RTP parameters',data:{viewer:this.user_id,producer:producer_user_id,producerRtpParams,consumerRtpParams,producerStats:producerStatsBefore},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H34'})}).catch(()=>{});
            // #endregion

            // Now request the keyframe - producer will send a fresh keyframe
            try {
                await videoConsumer.requestKeyFrame();
                console.log("[mediasoup] requestKeyFrame: requested keyframe for viewer", this.user_id, "from producer", producer_user_id);
            } catch (err) {
                // Consumer may have been closed (e.g. viewer disconnected) between check and call
                const msg = err instanceof Error ? err.message : String(err);
                if (msg.includes("not found") || videoConsumer.closed) {
                    console.log("[mediasoup] requestKeyFrame: consumer closed or gone, skipping", videoConsumer.id);
                    return false;
                }
                throw err;
            }

            // Get transport stats to verify packets are actually being sent
            let transportStats = null;
            if (this.transport && !this.transport.closed) {
                try {
                    const tStats = await this.transport.getStats();
                    // Find the transport-level stats
                    for (const stat of tStats) {
                        const s = stat as any;
                        if (s.type === 'webrtc-transport') {
                            transportStats = {
                                bytesReceived: s.bytesReceived,
                                bytesSent: s.bytesSent,
                                rtpBytesReceived: s.rtpBytesReceived,
                                rtpBytesSent: s.rtpBytesSent,
                                rtpPacketsReceived: s.rtpPacketsReceived,
                                rtpPacketsSent: s.rtpPacketsSent,
                                iceState: s.iceState,
                                dtlsState: s.dtlsState,
                            };
                            break;
                        }
                    }
                } catch (e) { /* ignore */ }
            }
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/043f8e22-2b34-44f1-b19b-fc11dd5647b1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'MediasoupWebRtcClient.ts:requestKeyFrame-transportStats',message:'Transport stats after keyframe request',data:{viewer:this.user_id,producer:producer_user_id,transportStats,transportClosed:this.transport?.closed},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H46'})}).catch(()=>{});
            // #endregion
            const tsLog = transportStats
                ? {
                    rtpBytesSent: transportStats.rtpBytesSent ?? "(n/a)",
                    rtpPacketsSent: transportStats.rtpPacketsSent ?? "(n/a)",
                    iceState: transportStats.iceState ?? "(n/a)",
                    dtlsState: transportStats.dtlsState ?? "(n/a)",
                }
                : "none";
            console.log("[mediasoup] requestKeyFrame: transport stats (viewer", this.user_id + "):", tsLog);

            // Get consumer stats to verify RTP flow
            let consumerStats = null;
            try {
                const stats = await videoConsumer.getStats();
                consumerStats = stats.length > 0 ? {
                    byteCount: stats[0].byteCount,
                    packetCount: stats[0].packetCount,
                    score: stats[0].score,
                    type: stats[0].type,
                } : null;
            } catch (e) { /* ignore stats error */ }
            console.log("[mediasoup] requestKeyFrame: consumer stats (viewer", this.user_id + ", producer", producer_user_id + "):", consumerStats ? { byteCount: consumerStats.byteCount, packetCount: consumerStats.packetCount } : "none");

            // Delayed check: after 2s, log again to verify RTP is actually being sent (runtime evidence for black video)
            setTimeout(async () => {
                try {
                    const tStats = this.transport && !this.transport.closed ? await this.transport.getStats() : [];
                    const cStats = await videoConsumer.getStats();
                    let rtpSent: number | undefined;
                    for (const s of tStats) {
                        const x = s as { type?: string; rtpBytesSent?: number };
                        if (x.type === "webrtc-transport") {
                            rtpSent = x.rtpBytesSent;
                            break;
                        }
                    }
                    const cByteCount = cStats.length > 0 ? (cStats[0] as { byteCount?: number }).byteCount : undefined;
                    let iceState: string | undefined;
                    let dtlsState: string | undefined;
                    for (const s of tStats) {
                        const x = s as { type?: string; iceState?: string; dtlsState?: string };
                        if (x.type === "webrtc-transport") {
                            iceState = x.iceState;
                            dtlsState = x.dtlsState;
                            break;
                        }
                    }
                    console.log("[mediasoup] requestKeyFrame @2s: viewer", this.user_id, "transport rtpBytesSent:", rtpSent, "iceState:", iceState ?? "(n/a)", "dtlsState:", dtlsState ?? "(n/a)", "consumer byteCount:", cByteCount);
                } catch (_) { /* ignore */ }
            }, 2000);

            // Get producer stats AFTER keyframe to check if producer is sending
            let producerStatsAfter = null;
            if (producer && !producer.closed) {
                try {
                    const stats = await producer.getStats();
                    producerStatsAfter = stats.length > 0 ? { 
                        byteCount: stats[0].byteCount,
                        packetCount: stats[0].packetCount,
                        score: stats[0].score,
                        type: stats[0].type,
                    } : null;
                } catch (e) { /* ignore stats error */ }
            }

            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/043f8e22-2b34-44f1-b19b-fc11dd5647b1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'MediasoupWebRtcClient.ts:requestKeyFrame-success',message:'Keyframe requested successfully',data:{viewer:this.user_id,producer:producer_user_id,consumerId:videoConsumer.id,consumerPausedNow:videoConsumer.paused,producerStatsBefore:producerStatsBefore,producerStatsAfter:producerStatsAfter,consumerStats:consumerStats},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H15'})}).catch(()=>{});
            // #endregion
            return true;
        } catch (error) {
            console.error("[mediasoup] requestKeyFrame failed:", error);
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/043f8e22-2b34-44f1-b19b-fc11dd5647b1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'MediasoupWebRtcClient.ts:requestKeyFrame-error',message:'requestKeyFrame failed',data:{viewer:this.user_id,producer:producer_user_id,error:String(error)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H13'})}).catch(()=>{});
            // #endregion
            return false;
        }
    }
}
