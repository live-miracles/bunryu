import { rtmpPullUrl, srtPullUrl } from '../utils/srs.js';

export type InputProtocol = 'srt' | 'rtmp';

// 4K UHD is 3840x2160; check against the larger dimension so a portrait/rotated
// 4K source (e.g. 2160x3840) is still caught.
const HIGH_RES_MIN_DIMENSION = 3840;

export interface InputState {
    setSrsReachable(reachable: boolean): void;
    setPipelineState(pipelineId: number, live: boolean, protocol: InputProtocol | null): void;
    setInputResolution(pipelineId: number, width: number | null, height: number | null): void;
    clearPipeline(pipelineId: number): void;
    isLive(pipelineId: number): boolean;
    isReady(pipelineId: number): boolean;
    getProtocol(pipelineId: number): InputProtocol | null;
    isHighRes(pipelineId: number): boolean;
    pullUrl(pipelineId: number, streamKey: string): string;
}

export function inputPullUrl(streamKey: string, protocol: InputProtocol | null): string {
    return protocol === 'srt' ? srtPullUrl(streamKey) : rtmpPullUrl(streamKey);
}

export function createInputState(): InputState {
    let srsReachable = false;
    const liveInputs = new Map<number, boolean>();
    const inputProtocols = new Map<number, InputProtocol>();
    const inputResolutions = new Map<number, { width: number; height: number }>();

    return {
        setSrsReachable(reachable: boolean): void {
            srsReachable = reachable;
        },

        setPipelineState(pipelineId: number, live: boolean, protocol: InputProtocol | null): void {
            liveInputs.set(pipelineId, live);
            if (protocol) {
                inputProtocols.set(pipelineId, protocol);
            } else {
                inputProtocols.delete(pipelineId);
            }
        },

        setInputResolution(pipelineId: number, width: number | null, height: number | null): void {
            if (width && height && width > 0 && height > 0) {
                inputResolutions.set(pipelineId, { width, height });
            } else {
                inputResolutions.delete(pipelineId);
            }
        },

        clearPipeline(pipelineId: number): void {
            liveInputs.delete(pipelineId);
            inputProtocols.delete(pipelineId);
            inputResolutions.delete(pipelineId);
        },

        isLive(pipelineId: number): boolean {
            return liveInputs.get(pipelineId) ?? false;
        },

        isReady(pipelineId: number): boolean {
            return srsReachable && (liveInputs.get(pipelineId) ?? false);
        },

        getProtocol(pipelineId: number): InputProtocol | null {
            return inputProtocols.get(pipelineId) ?? null;
        },

        isHighRes(pipelineId: number): boolean {
            const res = inputResolutions.get(pipelineId);
            return !!res && Math.max(res.width, res.height) >= HIGH_RES_MIN_DIMENSION;
        },

        pullUrl(pipelineId: number, streamKey: string): string {
            return inputPullUrl(streamKey, inputProtocols.get(pipelineId) ?? null);
        },
    };
}
