export type GraphNode = {
	id: string;
	label: string;
	type: string;
	filePath: string;
};

export type GraphEdge = {
	from: string;
	to: string;
	relation: string;
};

export type GraphData = {
	nodes: GraphNode[];
	edges: GraphEdge[];
};

/**
 * TODO: Replace this stub with the real Bob graph-generation integration.
 * Do not add Bob API details here until the integration method is confirmed.
 */
export async function generateGraph(): Promise<GraphData> {
	return {
		nodes: [],
		edges: [],
	};
}
