import * as mediasoup from "mediasoup";
import type { types as MediaSoupTypes } from "mediasoup";
import * as sdpTransform from "sdp-transform";
import type {
    Codec,
    RtpHeader,
    SignalingDelegate,
    WebRtcClient,
} from "@spacebarchat/spacebar-webrtc-types";
import { VoiceRoom } from "./VoiceRoom.js";
import { MediasoupWebRtcClient } from "./MediasoupWebRtcClient.js";

type AppData = MediaSoupTypes.AppData;

export interface RouterType {
    router: MediaSoupTypes.Router;
    worker: MediaSoupTypes.Worker<AppData>;
}

export class MediasoupSignalingDelegate implements SignalingDelegate {
    private _workers: MediaSoupTypes.Worker<AppData>[] = [];
    private _rooms: Map<string, VoiceRoom> = new Map();
    private nextWorkerIdx = 0;
    private _ip: string;

    async start(
        public_ip: string,
        portMin: number,
        portMax: number
    ): Promise<void> {
        this._ip = public_ip;
        const numWorkers = 2;

        for (let i = 0; i < numWorkers; i++) {
            const worker = await mediasoup.createWorker({
                logLevel: "debug",
                logTags: [
                    "info",
                    "ice",
                    "dtls",
                    "rtp",
                    "srtp",
                    "rtcp",
                    "rtx",
                    "bwe",
                    "score",
                    "simulcast",
                    "svc",
                    "sctp",
                ],
                rtcMinPort: portMin,
                rtcMaxPort: portMax,
                //disableLiburing: true,
            });

            worker.on("died", () => {
                console.error(
                    "mediasoup Worker died, exiting  in 2 seconds... [pid:%d]",
                    worker.pid
                );

                setTimeout(() => process.exit(1), 2000);
            });

            this._workers.push(worker);
        }
    }

    async join<T>(
        roomId: string,
        userId: string,
        ws: T,
        type: "guild-voice" | "dm-voice" | "stream"
    ): Promise<WebRtcClient<T>> {
        // if this is guild-voice or dm-voice, make sure user isn't already in a room of those types
        // user can be in many simultanous go live stream rooms though (can be in a voice channel and watching a stream for example, or watching multiple streams)
        const rooms =
            type === "stream"
                ? []
                : Array.from(this.rooms.values()).filter(
                      (room) =>
                          room.type === "dm-voice" ||
                          room.type === "guild-voice"
                  );
        let existingClient: WebRtcClient<T> | undefined;

        for (const room of rooms) {
            let result = room.getClientById(userId);
            if (result) {
                existingClient = result;
                break;
            }
        }

        if (existingClient) {
            console.log("client already connected, disconnect..");
            this.onClientClose(existingClient);
        }

        const room = await this.getOrCreateRoom(roomId, type)!;

        const client = new MediasoupWebRtcClient(userId, roomId, ws, room);
        if (type === "stream" && (ws as { session_id?: string }).session_id) {
            client.sessionId = (ws as { session_id: string }).session_id;
        }

        room.onClientJoin(client);

        return client;
    }

    async onOffer<T>(
        client: WebRtcClient<T>,
        sdpOffer: string,
        codecs: Codec[]
    ): Promise<{ sdp: string; selectedVideoCodec: string }> {
        const room = this._rooms.get(client.voiceRoomId);

        if (!room) {
            console.error(
                "error, client sent an offer but has not authenticated"
            );
            throw new Error("voice room not found");
        }

        // Parse offer using sdp-transform
        const offerSdp = sdpTransform.parse(sdpOffer);

        // Extract RTP header extensions from all media sections, deduplicated by URI
        const rtpHeadersByUri = new Map<string, RtpHeader>();
        const parsedCodecs: Codec[] = [];

        for (const media of offerSdp.media || []) {
            for (const ext of media.ext || []) {
                if (!rtpHeadersByUri.has(ext.uri)) {
                    rtpHeadersByUri.set(ext.uri, { uri: ext.uri, id: ext.value });
                }
            }
            
            // Extract codecs from SDP to ensure we have parameters (apt)
            for (const rtp of media.rtp || []) {
                const fmtp = media.fmtp?.find(f => f.payload === rtp.payload);
                const parameters: any = {};
                if (fmtp && fmtp.config) {
                    // Parse fmtp config (e.g. "apt=109;profile-level-id=...")
                    fmtp.config.split(';').forEach(pair => {
                        const [key, value] = pair.split('=');
                        if (key && value) parameters[key.trim()] = value.trim();
                    });
                }
                parsedCodecs.push({
                    name: rtp.codec as any,
                    payload_type: rtp.payload,
                    type: media.type as "audio" | "video",
                    parameters,
                } as any);
            }
        }
        const rtpHeaders: RtpHeader[] = Array.from(rtpHeadersByUri.values());

        const transport = await room.router.router.createWebRtcTransport({
            listenInfos: [{ ip: "0.0.0.0", announcedAddress: this._ip, protocol: "udp" }],
            enableUdp: true,
            initialAvailableOutgoingBitrate: 2500000,
        });

        // Pass parsedCodecs instead of the potentially incomplete 'codecs' argument
        room.onClientOffer(client as MediasoupWebRtcClient, transport, parsedCodecs, rtpHeaders);

        // Extract client's DTLS fingerprint from offer
        let clientFingerprint = offerSdp.fingerprint;
        if (!clientFingerprint && offerSdp.media && offerSdp.media.length > 0) {
            clientFingerprint = offerSdp.media[0].fingerprint;
        }
        if (!clientFingerprint) {
            throw new Error("No DTLS fingerprint in client offer");
        }

        await transport.connect({
            dtlsParameters: {
                fingerprints: [{
                    algorithm: clientFingerprint.type as MediaSoupTypes.FingerprintAlgorithm,
                    value: clientFingerprint.hash,
                }],
                role: "client",
            },
        });

        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/043f8e22-2b34-44f1-b19b-fc11dd5647b1',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'MediasoupSignalingDelegate.ts:onOffer-afterTransportConnect',message:'transport.connect() done',data:{userId:(client as any).user_id,roomId:(client as any).voiceRoomId,transportId:transport.id,iceState:(transport as any).iceState,dtlsState:(transport as any).dtlsState,iceSelectedTuple:(transport as any).iceSelectedTuple,iceParameters:transport.iceParameters,iceCandidates:transport.iceCandidates,dtlsParameters:transport.dtlsParameters},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1'})}).catch(()=>{});
        // #endregion

        // Create consumers for existing producers BEFORE building the answer so the answer SDP
        // can include consumer SSRCs. Otherwise the viewer's receiver never matches mediasoup's SSRC and no RTP is received.
        await (client as MediasoupWebRtcClient).subscribeToExistingProducersInRoom();

        // Emit "connected" so subscribeToProducers (Identify) can run; it will skip creating duplicate consumers.
        if (!client.webrtcConnected) {
            client.webrtcConnected = true;
            client.emitter.emit("connected");
            console.log("[mediasoup] transport created for user", (client as any).user_id, "- emitting connected immediately");
        }

        // Build SDP answer using sdp-transform
        const iceParams = transport.iceParameters;
        const iceCandidate = transport.iceCandidates[0];
        if (!iceCandidate) {
            throw new Error("mediasoup returned no ICE candidate");
        }
        const dtlsParams = transport.dtlsParameters;
        const fingerprint = dtlsParams.fingerprints.find(f => f.algorithm === "sha-256")!;
        const candidateIp = this._ip; // Use announced IP for remote clients

        // Build answer SDP object mirroring offer's media sections
        const answerSdp: sdpTransform.SessionDescription = {
            version: 0,
            origin: {
                username: "-",
                sessionId: Date.now().toString(),
                sessionVersion: 0,
                netType: "IN",
                ipVer: 4,
                address: "127.0.0.1",
            },
            name: "-",
            timing: { start: 0, stop: 0 },
            connection: { version: 4, ip: candidateIp },
            fingerprint: { type: "sha-256", hash: fingerprint.value },
            groups: offerSdp.groups, // Copy BUNDLE group from offer
            msidSemantic: { semantic: "WMS", token: "*" },
            media: [],
        };

        // Build m-lines for each media in the offer
        for (const offerMedia of offerSdp.media || []) {
            // Determine answer direction based on offer direction
            let direction: "sendonly" | "recvonly" | "sendrecv" | "inactive";
            switch (offerMedia.direction) {
                case "sendonly": direction = "recvonly"; break;
                case "recvonly": direction = "sendonly"; break;
                case "inactive": direction = "inactive"; break;
                default: direction = "sendrecv";
            }

            const answerMedia: sdpTransform.MediaDescription = {
                type: offerMedia.type,
                port: iceCandidate.port,
                protocol: "UDP/TLS/RTP/SAVPF",
                payloads: offerMedia.payloads, // Echo back offer's payload types
                connection: { version: 4, ip: candidateIp },
                rtcp: { port: iceCandidate.port }, // Required for client's cleanServerSDP parser (parsed1.atr.get("rtcp"))
                rtcpMux: "rtcp-mux",
                mid: offerMedia.mid,
                direction,
                iceUfrag: iceParams.usernameFragment,
                icePwd: iceParams.password,
                fingerprint: { type: "sha-256", hash: fingerprint.value },
                setup: "passive", // Server is passive (client initiated DTLS)
                candidates: [{
                    foundation: "1",
                    component: 1,
                    transport: iceCandidate.protocol.toUpperCase() as "UDP" | "TCP",
                    priority: iceCandidate.priority,
                    ip: candidateIp,
                    port: iceCandidate.port,
                    type: iceCandidate.type as "host" | "srflx" | "prflx" | "relay",
                }],
                // Copy RTP and fmtp from offer so payload types match
                rtp: offerMedia.rtp,
                fmtp: offerMedia.fmtp,
                rtcpFb: offerMedia.rtcpFb,
                ext: offerMedia.ext?.filter(e => !e.uri.includes("transport-wide-cc-extensions")),
            };

            // Reorder video payloads to prefer H264 (matches our producer creation logic)
            if (offerMedia.type === "video" && typeof offerMedia.payloads === 'string' && offerMedia.rtp) {
                const pts = offerMedia.payloads.split(" ").map(p => parseInt(p, 10));
                pts.sort((a, b) => {
                    const rtpA = offerMedia.rtp.find(r => r.payload === a);
                    const rtpB = offerMedia.rtp.find(r => r.payload === b);
                    const isH264A = rtpA?.codec.toUpperCase() === "H264";
                    const isH264B = rtpB?.codec.toUpperCase() === "H264";
                    if (isH264A && !isH264B) return -1;
                    if (!isH264A && isH264B) return 1;
                    return 0;
                });
                answerMedia.payloads = pts.join(" ");
            }

            // Include consumer SSRCs in video m-line so the viewer's receiver expects the SSRC mediasoup will send.
            if (offerMedia.type === "video") {
                const mc = client as MediasoupWebRtcClient;
                const videoConsumer = mc.consumers?.find((c) => c.kind === "video");
                const encoding = videoConsumer?.rtpParameters?.encodings?.[0] as { ssrc?: number; rtx?: { ssrc?: number } } | undefined;
                if (encoding?.ssrc) {
                    const cname = "mediasoup-" + (encoding.ssrc >>> 0);
                    answerMedia.ssrcs = [{ id: encoding.ssrc, attribute: "cname", value: cname }];
                    if (encoding.rtx?.ssrc) {
                        answerMedia.ssrcs.push({ id: encoding.rtx.ssrc, attribute: "cname", value: cname });
                    }
                }
            }

            answerSdp.media!.push(answerMedia);
        }

        // Use \n only so client's parsesdp (sdp.split("\n")) works; no trailing \r
        let sdp = sdpTransform.write(answerSdp);
        if (sdp.includes("\r")) {
            sdp = sdp.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        }

        console.log("[mediasoup] Generated Answer SDP:\n", sdp);

        return { sdp, selectedVideoCodec: "H264" };
    }

    onClientClose<T>(client: WebRtcClient<T>): void {
        this._rooms.get(client.voiceRoomId)?.onClientLeave(client as MediasoupWebRtcClient);
    }

    updateSDP(offer: string): void {
        throw new Error("Method not implemented.");
    }

    getClientsForRtcServer<T>(rtcServerId: string): Set<WebRtcClient<T>> {
        if (!this._rooms.has(rtcServerId)) {
            return new Set();
        }

        return new Set(this._rooms.get(rtcServerId)?.clients.values())!;
    }

    stop(): Promise<void> {
        return Promise.resolve();
    }

    get ip(): string {
        return this._ip;
    }

    get port(): number {
        return 9999; // idk
    }

    get rooms(): Map<string, VoiceRoom> {
        return this._rooms;
    }

    getNextWorker() {
        const worker = this._workers[this.nextWorkerIdx];

        if (++this.nextWorkerIdx === this._workers.length)
            this.nextWorkerIdx = 0;

        return worker;
    }

    async getOrCreateRoom(
        roomId: string,
        type: "guild-voice" | "dm-voice" | "stream"
    ) {
        if (!this._rooms.has(roomId)) {
            const worker = this.getNextWorker();
            const router = await worker.createRouter({
                mediaCodecs: MEDIA_CODECS,
            });

            const data = {
                router,
                worker,
            };

            const room = new VoiceRoom(roomId, type, this, data);
            this._rooms.set(roomId, room);
            return room;
        }

        return this._rooms.get(roomId)!;
    }
}

// Configure router codecs with specific preferredPayloadType values that match Chrome's offer.
export const MEDIA_CODECS: MediaSoupTypes.RtpCodecCapability[] = [
    {
        kind: "audio",
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2,
        rtcpFeedback: [{ type: "nack" }, { type: "transport-cc" }],
        parameters: {
            minptime: 10,
            usedtx: 1,
            useinbandfec: 1,
        },
        preferredPayloadType: 111,
    },
    // H264 must be enabled so producers accept browser screen-share (Chrome sends H264).
    // With only VP8, producer was created for VP8 but browser sent H264 → 0 RTP → black video.
    {
        kind: "video",
        mimeType: "video/H264",
        clockRate: 90000,
        parameters: {
            "level-asymmetry-allowed": 1,
            "packetization-mode": 1,
            "profile-level-id": "42001f", // Baseline Profile
        },
        rtcpFeedback: [
            { type: "nack" },
            { type: "nack", parameter: "pli" },
            { type: "ccm", parameter: "fir" },
            { type: "goog-remb" },
            { type: "transport-cc" },
        ],
        preferredPayloadType: 103, // H264 profile 42001f - Baseline
    },
    {
        kind: "video",
        mimeType: "video/H264",
        clockRate: 90000,
        parameters: {
            "level-asymmetry-allowed": 1,
            "packetization-mode": 1,
            "profile-level-id": "42e01f", // Constrained Baseline - common for Chrome screen share
        },
        rtcpFeedback: [
            { type: "nack" },
            { type: "nack", parameter: "pli" },
            { type: "ccm", parameter: "fir" },
            { type: "goog-remb" },
            { type: "transport-cc" },
        ],
        preferredPayloadType: 109, // H264 profile 42e01f - Constrained Baseline
    },
    {
        kind: "video",
        mimeType: "video/VP8",
        clockRate: 90000,
        parameters: {
            "x-google-start-bitrate": 1000,
        },
        rtcpFeedback: [
            { type: "nack" },
            { type: "nack", parameter: "pli" },
            { type: "ccm", parameter: "fir" },
            { type: "goog-remb" },
            { type: "transport-cc" },
        ],
        preferredPayloadType: 96,
    },
];
