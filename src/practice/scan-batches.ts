export const DEFAULT_SCAN_BATCH_SIZE = 250;

export function shouldYieldScanBatch(
	processed: number,
	total: number,
	batchSize = DEFAULT_SCAN_BATCH_SIZE
): boolean {
	return batchSize > 0 && processed > 0 && processed < total && processed % batchSize === 0;
}
