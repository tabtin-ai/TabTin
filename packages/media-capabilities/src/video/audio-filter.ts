/**
 * 共享音频混音 filter_complex 构建。
 * `ffmpeg-compose.ts` 把视频作为输入 0，音频输入从 1 开始。
 */

export interface NarrationEntry {
	path: string;
	/** 在时间线上的起始秒 */
	startSec: number;
	durationSec?: number;
	volume?: number;
}

export interface BgmEntry {
	path: string;
	/** 基础音量 (0-1)，无 ducking 时使用 */
	volume: number;
	/** ducking 包络：语音时压低，静默时恢复 */
	duckingEnvelope?: Array<{ startSec: number; endSec: number; volume: number }>;
	fadeOutSec?: number;
}

export interface BuildAudioMixParams {
	narrations: NarrationEntry[];
	bgm?: BgmEntry;
	totalDurationSec: number;
	/** 第一个音频输入在 ffmpeg `-i` 列表中的下标（视频占 0，故通常为 1）。 */
	firstInputIndex: number;
}

export interface AudioMixResult {
	/** 需追加的 `-i` 音频输入路径，顺序与 filter 下标一致（先 narrations 后 bgm）。 */
	inputPaths: string[];
	/** filter_complex 片段。 */
	filterParts: string[];
	/** 最终音频流 label（空串表示无音频）。 */
	finalAudioLabel: string;
}

/**
 * 从 ducking 包络生成 FFmpeg volume 表达式。
 *
 * 输出形如：if(between(t,0,3),0.15,if(between(t,3,3.5),0.6,...,0.3))
 * 末尾 fallback 使用 baseVolume。
 */
export function buildVolumeExpr(
	envelope: Array<{ startSec: number; endSec: number; volume: number }>,
	baseVolume: number,
): string {
	if (envelope.length === 0) return String(baseVolume);

	let expr = "";
	for (const seg of envelope) {
		const v = seg.volume.toFixed(3);
		expr += `if(between(t\\,${seg.startSec.toFixed(3)}\\,${seg.endSec.toFixed(3)})\\,${v}\\,`;
	}
	expr += baseVolume.toFixed(3);
	expr += ")".repeat(envelope.length);
	return expr;
}

/**
 * 构建旁白 + BGM 的混音 filter_complex。
 *
 * 旁白：按 startSec adelay → 可选 volume → apad 到全长 → amix。
 * BGM：ducking volume 表达式 / 静态音量 → 可选 afade → atrim+apad → 与旁白 amix。
 */
export function buildAudioMixFilter(params: BuildAudioMixParams): AudioMixResult {
	const { narrations, bgm, totalDurationSec, firstInputIndex } = params;
	const inputPaths: string[] = [];
	const filterParts: string[] = [];

	for (const nar of narrations) inputPaths.push(nar.path);
	if (bgm) inputPaths.push(bgm.path);

	// 旁白
	const narLabels: string[] = [];
	for (let i = 0; i < narrations.length; i++) {
		const nar = narrations[i];
		const delayMs = Math.round(nar.startSec * 1000);
		const vol = nar.volume ?? 1.0;
		const label = `nar${i}`;

		let filter = `[${firstInputIndex + i}:a]`;
		if (delayMs > 0) {
			filter += `adelay=${delayMs}|${delayMs},`;
		}
		if (Math.abs(vol - 1.0) > 0.01) {
			filter += `volume=${vol},`;
		}
		filter += `apad=whole_dur=${totalDurationSec.toFixed(3)}`;
		filter += `[${label}]`;
		filterParts.push(filter);
		narLabels.push(`[${label}]`);
	}

	let speechLabel = "";
	if (narLabels.length > 0) {
		if (narLabels.length === 1) {
			speechLabel = narLabels[0].slice(1, -1);
		} else {
			filterParts.push(
				`${narLabels.join("")}amix=inputs=${narLabels.length}:duration=longest:dropout_transition=0[speech]`,
			);
			speechLabel = "speech";
		}
	}

	// BGM
	const bgmInputIndex = firstInputIndex + narrations.length;
	let bgmLabel = "";
	if (bgm) {
		const baseVol = bgm.volume;
		let bgmFilter = `[${bgmInputIndex}:a]`;

		if (bgm.duckingEnvelope && bgm.duckingEnvelope.length > 0) {
			const volExpr = buildVolumeExpr(bgm.duckingEnvelope, baseVol);
			bgmFilter += `volume='${volExpr}':eval=frame`;
		} else {
			bgmFilter += `volume=${baseVol}`;
		}

		if (bgm.fadeOutSec && bgm.fadeOutSec > 0) {
			const fadeStart = Math.max(0, totalDurationSec - bgm.fadeOutSec);
			bgmFilter += `,afade=t=out:st=${fadeStart.toFixed(3)}:d=${bgm.fadeOutSec.toFixed(3)}`;
		}

		bgmFilter += `,atrim=0:${totalDurationSec.toFixed(3)},apad=whole_dur=${totalDurationSec.toFixed(3)}`;
		bgmLabel = "bgm_proc";
		bgmFilter += `[${bgmLabel}]`;
		filterParts.push(bgmFilter);
	}

	// 最终混合
	let finalAudioLabel = "";
	if (speechLabel && bgmLabel) {
		filterParts.push(
			`[${speechLabel}][${bgmLabel}]amix=inputs=2:duration=longest:dropout_transition=0[audio_mix]`,
		);
		finalAudioLabel = "audio_mix";
	} else if (speechLabel) {
		finalAudioLabel = speechLabel;
	} else if (bgmLabel) {
		finalAudioLabel = bgmLabel;
	}

	return { inputPaths, filterParts, finalAudioLabel };
}
