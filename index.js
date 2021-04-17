import {getTestData} from './testData.js';
import {TaskInstanceTree} from './taskInstanceTree.js';

const response = getTestData();
console.log(response);
response.forEach(data => {
    const tree = new TaskInstanceTree(data.dag_id, data.nodes);
    document.querySelector('body').appendChild(tree);
});
