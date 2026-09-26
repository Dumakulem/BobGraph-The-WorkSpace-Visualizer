(function () {
	'use strict';

	const vscode = acquireVsCodeApi();
	const graphElement = document.getElementById('graph');
	const statusElement = document.getElementById('status');
	const detailsElement = document.getElementById('details');
	const summaryElement = document.getElementById('summary');
	const refreshButton = document.getElementById('refresh');
	let network;

	refreshButton.addEventListener('click', () => {
		vscode.postMessage({ type: 'requestRefresh' });
	});

	window.addEventListener('message', (event) => {
		const message = event.data;

		switch (message.type) {
			case 'graphData':
				renderGraph(message.graph);
				break;
			case 'graphLoading':
				graphElement.classList.add('loading');
				graphElement.textContent = '';
				statusElement.textContent = 'Loading workspace graph…';
				refreshButton.disabled = true;
				break;
			case 'explanationLoading':
				summaryElement.textContent = 'Bob is preparing a summary…';
				detailsElement.hidden = false;
				statusElement.textContent = `Explaining node: ${message.nodeId}`;
				break;
			case 'nodeExplanation':
				summaryElement.textContent = message.summary;
				detailsElement.hidden = false;
				statusElement.textContent = `Selected: ${message.nodeId}`;
				break;
			case 'error':
				graphElement.classList.remove('loading');
				graphElement.textContent = message.message;
				statusElement.textContent = 'Error';
				refreshButton.disabled = false;
				break;
			default:
				break;
		}
	});

	function renderGraph(graph) {
		graphElement.classList.remove('loading');
		refreshButton.disabled = false;

		// Destroy the previous vis.Network instance before creating a new one.
		// Without this, every refresh leaks canvas listeners and internal state.
		if (network) {
			network.destroy();
			network = undefined;
		}

		if (graph.nodes.length === 0) {
			graphElement.textContent =
				'No nodes found. Run "BobGraph: Generate Workspace Graph" to create .bobgraph/workspace-graph.json.';
			statusElement.textContent = 'Graph is empty.';
			return;
		}

		// Keep untrusted graph data as text; never interpolate it with innerHTML.
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
		statusElement.textContent = `${graph.nodes.length} nodes · ${graph.edges.length} edges`;
	}

	vscode.postMessage({ type: 'ready' });
}());
