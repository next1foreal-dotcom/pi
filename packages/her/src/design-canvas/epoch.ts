/** Process-local compaction generation. Nag uses this to re-hitchhike after a squeeze. */

let epoch = 0;

export function bumpCompactionEpoch(): void {
	epoch += 1;
}

export function compactionEpoch(): number {
	return epoch;
}
