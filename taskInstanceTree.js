import * as d3 from 'd3';
import moment from 'moment';

const template = document.createElement('template')
template.innerHTML = `
<style>
.group {
    fill: cornflowerblue;
}

.task {
    fill: green;
}

.links {
    fill: none;
    stroke: grey;
    stroke-width: 0.5;
}

.label {
    color: black;
    fill: black;
    font: 1em monospace;
}

.axis-label {
    font: 1em monospace;
}

.task-group-rect {
    fill: cornflowerblue;
    stroke: cornflowerblue;
}

.task-instance-rect {
    fill: green;
    stroke: green;
}

/* rect-unchecked must appear after task-group-rect and task-instance-rect */
.rect-unchecked {
    fill: white;
}

</style>
<h2 id='message'></h2>
<div class='tree-container'>
</div>
`

// Create a hierachical root from a flat list structure of tasks
function stratifyDag(dagId, tasks) {
    const stratifyTasks = d3.stratify().id(d => d.id).parentId(parent = d => d.group_id);

    const dummyRoot = {
        id: '[DAG]',
        label: dagId,
        group_id: null,
    };

    const nodesList = tasks.map(t => {
        const taskCopy = Object.assign({}, t);
        if (taskCopy.group_id === null)
            taskCopy.group_id = dummyRoot.id;
        return taskCopy;
    })
    nodesList.push(dummyRoot);
    return stratifyTasks(nodesList);
}

// Simple helper for constructing translate() string
function translate(x, y) {
    return `translate(${x}, ${y})`;
}

// Create identifier for a rect checkbox
function rectId(taskId, executionDate) {
    return JSON.stringify([taskId, executionDate]);
}

function childrenNodeIds(node) {
    const nodeIds = [];
    node.each(child => nodeIds.push(child.id));
    return nodeIds;
}

// Given a node, return the unique execution_date of itself and its children
function childrenExecutionDates(node) {
    const uniqueDates = new Set();

    node.each(child => {
        if (child.data.task_instances)
            child.data.task_instances.forEach(date => uniqueDates.add(date));
    });

    return uniqueDates;
}

export class TaskInstanceTree extends HTMLElement {
    constructor(dagId, nodes) {
        super();
        this.attachShadow({ mode: 'open' });
        this.shadowRoot.appendChild(template.content.cloneNode(true));
        this.shadowRoot.querySelector('#message').innerText = this.getAttribute('message');
        this.taskInstanceMap = new Map();
        this.dagId = dagId;
        this.root = stratifyDag(dagId, nodes);

        this.root.each(d => {
            d.id = d.data.id;
            d.x0 = this.root.x0;
            d.y0 = this.root.y0;
            d._children = d.children;
        });

        this.root.each(node => {
            const nodeIds = childrenNodeIds(node);
            node.row = Array.from(childrenExecutionDates(node)).map(date => {
                const executionDate = moment.parseZone(date);
                const id = rectId(node.data.id, executionDate);
                const state = {
                    id: id,
                    node: node,
                    nodeType: node._children ? 'TaskGroup' : 'BaseOperator',
                    executionDate: executionDate,
                    // The nodes this node should select/deselect when clicked.
                    nodeIds: nodeIds,
                    checked: true
                };
                this.taskInstanceMap.set(id, state);
                return state;
            });
        });
        this.renderTree();
    }

    renderTree() {
        // Size of each tree node
        const nodeSize = 16;
        // Page margin
        const margin = 6 * nodeSize;
        // The vertical spacing between nodes
        const vSpread = nodeSize * 1.3;
        // The horizontal spacing between nodes
        const hSpread = nodeSize * 10;

        this.root.x0 = nodeSize / 2;
        this.root.y0 = 0;

        const treeLayout = d3.tree().nodeSize([vSpread, hSpread]);

        // Find the range of execution_date
        var minDate = null;
        var maxDate = null;
        this.root.leaves().forEach(d => {
            d.data.task_instances.forEach(date_str => {
                const date = moment.parseZone(date_str);
                if (minDate == null || date < minDate)
                    minDate = date;
                else if (maxDate == null || date > maxDate)
                    maxDate = date;
            })
        });

        // The point on the horizontal scale where the task instances should be placed
        const hStart = hSpread * this.root.height;

        // The scale used to place task instances on the horizontal axis.
        // TODO: This calculation needs to be updated to handle different schedule_intervals
        const numSquares = maxDate.diff(minDate, 'days');

        const ticks = [...Array(numSquares).keys()].map(i => minDate.clone().add(i, 'day'));

        const hScale = d3.scaleTime()
            .domain([minDate, maxDate])
            .range([hStart, hStart + numSquares * vSpread]);

        const svg = d3.create('svg').attr('width', currentWidth());

        const canvas = svg.append('g').attr('transform', translate(nodeSize, margin));

        const duration = 250;

        const gLink = canvas.append("g").attr('class', 'links');

        const gNode = canvas.append("g").attr('class', 'nodes');

        // Collapse/Expand the tree at node
        function toggleNode(node) {
            node.children = node.children ? null : node._children;
        }

        // Calculate the current page height needed to display the tree
        function currentHeight() {
            return (treeObj.root.descendants().length * vSpread + vSpread) + margin;
        }

        // Calculate the current page width needed to display the tree
        function currentWidth() {
            return hScale.range()[1] + margin;
        }

        const treeObj = this;

        function update(source) {
            const links = treeObj.root.links();

            // Compute the new tree layout.
            treeLayout(treeObj.root);

            var i = 0;
            // Push nodes down (pre-order traversal)
            treeObj.root.eachBefore(d => {
                d.x = vSpread * i++;
                // Align the leaf nodes to the right.
                if (!d.children && d.parent != null)
                    d.y = hStart - vSpread / 2;
            });

            let left = treeObj.root;
            let right = treeObj.root;

            treeObj.root.eachBefore(d => {
                if (d.x < left.x) left = d;
                if (d.x > right.x) right = d;
            });

            // Update the nodes…
            const nodeSelection = gNode.selectAll("g.task-node")
                .data(treeObj.root.descendants(), d => d.id);

            // Enter any new nodes at the parent's previous position.
            const nodeEnter = nodeSelection.enter().append("g")
                .attr('class', 'task-node')
                .attr("transform", d => translate(source.y0, source.x0))
                .attr("fill-opacity", 0)
                .attr("stroke-opacity", 0);

            nodeEnter.append("circle")
                .attr("r", nodeSize / 2)
                .attr("class", d => d._children ? 'group' : 'task')
                // NOTE: The signature of the callable changed in d3 v6.
                .on("click", (event, d) => {
                    event.preventDefault();
                    toggleNode(d);
                    update(d);
                });

            // Transition nodes to their new position.
            nodeSelection.merge(nodeEnter).transition().duration(duration)
                .attr("transform", d => translate(d.y, d.x))
                .attr("fill-opacity", 1)
                .attr("stroke-opacity", 1);

            // Transition exiting nodes to the parent's new position.
            nodeSelection.exit().transition().duration(duration).remove()
                .attr("transform", d => translate(source.y, source.x))
                .attr("fill-opacity", 0)
                .attr("stroke-opacity", 0);

            // Returns if node is a leaf node (except a collapsed root node)
            function isLeafNode(node) {
                return (!node.children && node.parent != null);
            }

            nodeEnter.append("text")
                .attr("class", 'label')
                .attr("dy", '0.31em')
                // Use merge because text attributes may change when collapsing expanding nodes
                .merge(nodeSelection.select('text'))
                .transition().duration(duration)
                .attr('text-anchor', d => isLeafNode(d) ? 'end' : 'start')
                .attr("x", d => (isLeafNode(d) ? -nodeSize : nodeSize) * 0.8)
                .text(d => d.data.label);

            // Create or update a node-state-rect-group for each TaskInstance and TaskGroup.
            // This is the container for task instance checkboxes on the same row.
            // Also sets up the nodes so that each node has a row attribute that corresponds to
            // the row of task instance state rect for that node.
            const taskRowSelection = gNode.selectAll("g.node-state-rect-group")
                .data(treeObj.root.descendants(), d => d.id);

            const taskRowEnter = taskRowSelection
                .enter()
                .append('g');

            taskRowEnter
                .merge(taskRowSelection)
                // Add new rect at the original location of the node (i.e. where it's clicked)
                .attr('class', 'node-state-rect-group')

            taskRowEnter
                // Add new rect at the original location of the node (i.e. where it's clicked)
                .attr('transform', d => translate(hStart, source.x0))
                .transition().duration(duration)
                .attr('transform', d => translate(0, d.x - nodeSize / 2));

            taskRowSelection
                // Update existing rect from the original location
                .attr('transform', d => translate(0, d.x0 - nodeSize / 2))
                .transition().duration(duration)
                .attr('transform', d => translate(0, d.x - nodeSize / 2));


            taskRowSelection.exit().transition().duration(duration).remove().attr("transform", () => translate(0, source.x));

            // For every row, add the cells
            const nodeStateRectSelection = taskRowEnter.selectAll('rect.task-instance-rect,rect.task-group-rect')
                .data(d => d.row, d => d.id);

            function toggleChecked(cell) {
                console.log(`Toggle ${cell.node.data.id} ${cell.executionDate.format('YYYYMMDD')} ${cell.nodeIds}`);
                cell.checked = !cell.checked;
                const rectIds = new Set(cell.nodeIds.map(nodeId => rectId(nodeId, cell.executionDate)));
                // Update model state. Some tasks do not have a TaskInstance on certain days so filter out undefined.
                Array.from(rectIds).map(id => treeObj.taskInstanceMap.get(id)).filter(d => d != undefined).forEach(state => state.checked = cell.checked);
                // Update UI state TODO: Why is this needed when update(cell.node) is called?
                // update(cell.node);
                const target = gNode.selectAll('rect').filter(d => rectIds.has(d.id));
                target.classed('rect-unchecked', !cell.checked);
            }

            const nodeStateRectEnter = nodeStateRectSelection.enter();

            nodeStateRectEnter
                .append('rect')
                .merge(nodeStateRectSelection)
                .attr('class', d => d.nodeType == 'TaskGroup' ? 'task-group-rect' : 'task-instance-rect')
                // TODO: This should be the only place the unchecked class needs to be set.
                .classed('rect-unchecked', d => !d.checked)
                .attr('width', nodeSize)
                .attr('height', nodeSize)
                .on('click', (event, d) => {
                    event.preventDefault();
                    toggleChecked(d);
                })
                .transition().duration(duration)
                .attr('x', d => {
                    return hScale(d.executionDate)
                });

            // Label the top row (the cells that have no parent). Similar outcome could have been achieved with
            // d3.axisTop(), but it makes the axis label too difficult to align with the cells perfectly.
            // So creating a text element for each top rect instead.
            nodeStateRectEnter.filter(d => d.node.parent == null)
                .append('text')
                .text(d => d.executionDate.format('YYYYMMDD'))
                .transition().duration(duration)
                .attr('transform', d => `${translate(hScale(d.executionDate) + vSpread / 2, -vSpread / 2)} rotate(-60)`)
                .attr('class', 'axis-label');

            // Draw link and transition it to the location to link source and target nodes
            function drawLinkWithTransition(action) {
                // M (Move to): Absolute coordiniate specifying where to start drawing the path
                // V (Vertical line): Absolute coordinate specifying how long to draw in the y direction
                // H (Horitontal line): Absolute coordinate specifying how long to draw in the x direction
                // For more info, see SVG documentation on Paths:
                // https://developer.mozilla.org/en-US/docs/Web/SVG/Tutorial/Paths
                return action
                    .transition().duration(duration)
                    .attr("d", d => `
                        M${d.source.y},${d.source.x}
                        V${d.target.x}
                        H${d.target.y}
                    `);
            }

            // Update the links…
            gLink.selectAll("path")
                .data(links, d => d.target.id)
                .join(
                    enter => enter.append('path')
                        // First draw the link at the source and then transition to the final position
                        .attr("d", () => `
                            M${source.y0},${source.x0}
                            V${source.x0}
                            H${source.y0}
                        `)
                        .call(drawLinkWithTransition),
                    update => update.call(drawLinkWithTransition),
                    exit => exit.transition().duration(duration).remove()
                        .attr("d", () => `
                        M${source.y},${source.x}
                        V${source.x}
                        H${source.y}
                    `)
                );

            // Stash the old positions for transition.
            treeObj.root.eachBefore(d => {
                d.x0 = d.x;
                d.y0 = d.y;
            });

            svg.transition().duration(duration).attr('height', currentHeight());
        }

        // Collapse all nodes except the first level of children
        treeObj.root.descendants().filter(d => d.id != treeObj.root.id).forEach(d => toggleNode(d));
        update(treeObj.root);
        // Add to DOM
        this.shadowRoot.querySelector('.tree-container').appendChild(svg.node());
    }

    getExcludedTaskInstances() {
        return Array.from(this.taskInstanceMap.values()).filter(val => !val.checked && val.nodeType == 'BaseOperator')
            .map(val => {
                const [task_id, execution_date] = JSON.parse(val.id);
                return {dag_id: this.dagId, task_id: task_id, execution_date: execution_date};
            });
    }
};

customElements.define('task-instance-tree', TaskInstanceTree);
