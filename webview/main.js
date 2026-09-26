(function () {
	'use strict';

	const vscode = acquireVsCodeApi();
	const graphElement = document.getElementById('graph');
	const statusElement = document.getElementById('status');
	const detailsElement = document.getElementById('details');
	const summaryElement = document.getElementById('summary');
	let network;

	window.addEventListener('message', (event) => {
		const message = event.data;

		switch (message.type) {
			case 'graphData':
				renderGraph(message.graph);
				break;
			case 'graphLoading':
				statusElement.textContent = 'Bob is generating the workspace graph...';
				graphElement.classList.add('loading');
				break;
			case 'explanationLoading':
				summaryElement.textContent = 'Bob is preparing a summary...';
				detailsElement.hidden = false;
				statusElement.textContent = `Explaining node: ${message.nodeId}`;
				break;
			case 'nodeExplanation':
				summaryElement.textContent = message.summary;
				detailsElement.hidden = false;
				statusElement.textContent = `Selected node: ${message.nodeId}`;
				break;
			case 'error':
				statusElement.textContent = message.message;
				graphElement.classList.remove('loading');
				break;
			default:
				break;
		}
	});

	function renderGraph(graph) {
		graphElement.classList.remove('loading');
		if (graph.nodes.length === 0) {
			graphElement.textContent = 'No workspace graph data is available yet.';
			statusElement.textContent = 'The graph is empty.';
			return;
		}

		graphElement.textContent = '';
		const nodes = new vis.DataSet(graph.nodes.map((node) => ({
			id: node.id,
			label: node.label,
			title: `${node.type}: ${node.filePath}`,
		})));
		const edges = new vis.DataSet(graph.edges.map((edge) => ({
			from: edge.from,
			to: edge.to,
			label: edge.relation,
			arrows: 'to',
		})));

		network = new vis.Network(graphElement, { nodes, edges }, {
			autoResize: true,
			interaction: { hover: true },
			physics: { stabilization: true },
			nodes: { shape: 'box', margin: 12 },
			edges: { font: { align: 'middle' } },
		});
		network.on('click', (event) => {
			const nodeId = event.nodes[0];
			if (nodeId !== undefined) {
				vscode.postMessage({ type: 'nodeClicked', nodeId });
			}
		});
		statusElement.textContent = `${graph.nodes.length} nodes, ${graph.edges.length} relationships`;
	}

	vscode.postMessage({ type: 'ready' });
}());
