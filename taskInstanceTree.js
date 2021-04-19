/*
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

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

// Given a node, return the unique execution_date of itself and its children
function childrenExecutionDates(node) {
    const uniqueDates = new Set();

    node.each(child => {
        if (child.data.task_instances)
            child.data.task_instances.forEach(date => uniqueDates.add(date));
    });

    return uniqueDates;
}

// Find the height of the tree that is currently expanded
function expandedHeight(node) {
    if (!node.children)
        return 0;

    return 1 + Math.max(...node.children.map(child => expandedHeight(child)));
}

// Returns if node is a leaf node (except a collapsed root node)
function isLeafNode(node) {
    return (!node.children && node.parent != null);
}

export class TaskInstanceTree extends HTMLElement {
    constructor(dagId, nodes) {
        super();
        this.attachShadow({ mode: 'open' });
        this.shadowRoot.appendChild(template.content.cloneNode(true));
        this.shadowRoot.querySelector('#message').innerText = this.getAttribute('message');
        this.cellStateMap = new Map();
        this.dagId = dagId;
        this.root = stratifyDag(dagId, nodes);

        // Initialize the data for each node
        this.root.each(node => {
            node.id = node.data.id;
            node.x0 = this.root.x0;
            node.y0 = this.root.y0;
            // _children isn't changed when node is expanded/collapsed.
            node._children = node.children;

            const nodeIds = [];
            node.each(child => nodeIds.push(child.id));
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
                this.cellStateMap.set(id, state);
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

        const maxLabelLength = Math.max(...this.root.descendants().map(d => d.data.label.length));

        // The horizontal spacing between nodes
        const hSpread = nodeSize * Math.min(15, maxLabelLength);

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


        // The scale used to place task instances on the horizontal axis.
        // TODO: This calculation needs to be updated to handle different schedule_intervals
        const numSquares = maxDate.diff(minDate, 'days');

        const svg = d3.create('svg');

        const canvas = svg.append('g').attr('transform', translate(nodeSize, margin));

        const duration = 250;

        const gLink = canvas.append("g").attr('class', 'links');

        const gNode = canvas.append("g").attr('class', 'nodes');

        // Collapse/Expand the tree at node
        function toggleNode(node) {
            node.children = node.children ? null : node._children;
        }

        const treeObj = this;

        const hScale = d3.scaleTime()
            .domain([minDate, maxDate])
            .range([0, 0 + numSquares * vSpread]);

        let hStart0 = 0;
        let hStart = 0;

        function update(source) {
            // The point on the horizontal scale where the task instances should be placed
            hStart0 = hStart;
            hStart = hSpread * Math.max(1, expandedHeight(treeObj.root));

            const links = treeObj.root.links();

            // Compute the new tree layout.
            treeLayout(treeObj.root);

            svg.transition().duration(duration)
                // Calculate the current page height needed to display the tree
                .attr('height', (treeObj.root.descendants().length * vSpread + vSpread) + margin)
                // Calculate the current page width needed to display the tree
                .attr('width', hStart + hScale.range()[1] + margin);

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
            const nodeUpdate = gNode.selectAll("g.task-node")
                .data(treeObj.root.descendants(), d => d.id);

            // Enter any new nodes at the parent's previous position.
            const nodeEnter = nodeUpdate.enter().append("g");

            nodeEnter
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
            nodeUpdate.merge(nodeEnter)
                .transition().duration(duration)
                .attr("transform", d => translate(d.y, d.x))
                .attr("fill-opacity", 1)
                .attr("stroke-opacity", 1);

            // Transition exiting nodes to the parent's new position.
            nodeUpdate.exit().transition().duration(duration).remove()
                .attr("transform", d => translate(source.y, source.x))
                .attr("fill-opacity", 0)
                .attr("stroke-opacity", 0);

            nodeEnter.append("text")
                .attr("class", 'label')
                .attr("dy", '0.31em')
                // Use merge because text attributes may change when collapsing expanding nodes
                .merge(nodeUpdate.select('text'))
                .transition().duration(duration)
                .attr('text-anchor', d => isLeafNode(d) ? 'end' : 'start')
                .attr("x", d => (isLeafNode(d) ? -nodeSize : nodeSize) * 0.8)
                .text(d => d.data.label);

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

            // Create or update a node-state-rect-group for each TaskInstance and TaskGroup.
            // This is the container for task instance checkboxes on the same row.
            // Also sets up the nodes so that each node has a row attribute that corresponds to
            // the row of task instance state rect for that node.
            const taskRowUpdate = gNode.selectAll("g.node-state-rect-group")
                .data(treeObj.root.descendants(), d => d.id);

            const taskRowEnter = taskRowUpdate
                .enter()
                .append('g');

            taskRowEnter
                .merge(taskRowUpdate)
                .attr('class', 'node-state-rect-group')

            taskRowEnter
                // Add new rect at the original location of the node (i.e. where it's clicked)
                .attr('transform', d => translate(hStart0, source.x0))
                .transition().duration(duration)
                .attr('transform', d => translate(hStart, d.x - nodeSize / 2));

            taskRowUpdate
                // Update existing rect from the original location
                .attr('transform', d => translate(hStart0, d.x0 - nodeSize / 2))
                .transition().duration(duration)
                .attr('transform', d => translate(hStart, d.x - nodeSize / 2));


            taskRowUpdate.exit().transition().duration(duration).remove().attr("transform", () => translate(hStart, source.x));


            function toggleChecked(cell) {
                cell.checked = !cell.checked;
                const rectIds = new Set(cell.nodeIds.map(nodeId => rectId(nodeId, cell.executionDate)));
                // Update model state. Some tasks do not have a TaskInstance on certain days so filter out undefined.
                Array.from(rectIds).map(id => treeObj.cellStateMap.get(id)).filter(d => d != undefined).forEach(state => state.checked = cell.checked);
            }

            // For every row, add the cells
            const nodeStateRectUpdate = taskRowEnter.merge(taskRowUpdate).selectAll('rect.task-instance-rect,rect.task-group-rect')
                .data(d => d.row, d => d.id);

            const nodeStateRectEnterUpdate = nodeStateRectUpdate.enter().append('rect').merge(nodeStateRectUpdate);

            nodeStateRectEnterUpdate
                .attr('class', d => d.nodeType == 'TaskGroup' ? 'task-group-rect' : 'task-instance-rect')
                .attr('width', nodeSize)
                .attr('height', nodeSize)
                .on('click', (event, d) => {
                    event.preventDefault();
                    toggleChecked(d);
                    updateSelection();
                })
                .transition().duration(duration)
                .attr('x', d => {
                    return hScale(d.executionDate)
                });


            function updateSelection() {
                nodeStateRectEnterUpdate
                    .classed('rect-unchecked', d => !d.checked);
            }

            updateSelection();

            // Label the top row (the cells that have no parent). Similar outcome could have been achieved with
            // d3.axisTop(), but it makes the axis label too difficult to align with the cells perfectly.
            // So creating a text element for each top rect instead.
            nodeStateRectUpdate.enter().filter(d => d.node.parent == null)
                .append('text')
                .text(d => d.executionDate.format('YYYYMMDD'))
                .transition().duration(duration)
                .attr('transform', d => `${translate(hScale(d.executionDate) + vSpread / 2, -vSpread / 2)} rotate(-60)`)
                .attr('class', 'axis-label');
        }

        // Collapse all nodes except the first level of children
        treeObj.root.descendants().filter(d => d.id != treeObj.root.id).forEach(d => toggleNode(d));
        update(treeObj.root);
        // Add to DOM
        this.shadowRoot.querySelector('.tree-container').appendChild(svg.node());
    }

    getExcludedTaskInstances() {
        return Array.from(this.cellStateMap.values()).filter(val => !val.checked && val.nodeType == 'BaseOperator')
            .map(val => {
                const [task_id, execution_date] = JSON.parse(val.id);
                return { dag_id: this.dagId, task_id: task_id, execution_date: execution_date };
            });
    }
};

customElements.define('task-instance-tree', TaskInstanceTree);
