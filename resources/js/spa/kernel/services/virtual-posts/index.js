function calculateVirtualPostWindow(heights = [], scrollTop = 0, viewportHeight = 0, options = {}) {
	const safeHeights = Array.isArray(heights)
		? heights.map((height) => Math.max(1, Number(height) || 1))
		: [];
	const totalCount = safeHeights.length;
	const threshold = Math.max(0, Number(options.threshold ?? 30));
	const overscan = Math.max(0, Number(options.overscan ?? 3));
	const totalHeight = safeHeights.reduce((total, height) => total + height, 0);

	if(! totalCount) {
		return { start: 0, end: -1, top: 0, bottom: 0, total: 0 };
	}

	if(totalCount <= threshold) {
		return { start: 0, end: totalCount - 1, top: 0, bottom: 0, total: totalHeight };
	}

	const safeViewportHeight = Math.max(1, Number(viewportHeight) || 1);
	const safeScrollTop = Math.min(Math.max(0, Number(scrollTop) || 0), Math.max(0, totalHeight - 1));
	let firstVisible = 0;
	let lastVisible = totalCount - 1;
	let offset = 0;

	for(let index = 0; index < totalCount; index++) {
		const itemBottom = offset + safeHeights[index];

		if(itemBottom >= safeScrollTop) {
			firstVisible = index;
			break;
		}

		offset = itemBottom;
	}

	offset = safeHeights.slice(0, firstVisible).reduce((total, height) => total + height, 0);
	lastVisible = firstVisible;

	for(let index = firstVisible; index < totalCount; index++) {
		lastVisible = index;
		offset += safeHeights[index];

		if(offset >= safeScrollTop + safeViewportHeight) {
			break;
		}
	}

	const start = Math.max(0, firstVisible - overscan);
	const end = Math.min(totalCount - 1, lastVisible + overscan);
	const top = safeHeights.slice(0, start).reduce((total, height) => total + height, 0);
	const renderedHeight = safeHeights.slice(start, end + 1).reduce((total, height) => total + height, 0);

	return {
		start,
		end,
		top,
		bottom: Math.max(0, totalHeight - top - renderedHeight),
		total: totalHeight,
	};
}

export { calculateVirtualPostWindow };
