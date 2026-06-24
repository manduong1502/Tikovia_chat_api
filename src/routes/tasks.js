const express = require('express');
const router = express.Router();
const taskController = require('../controllers/taskController');
const verifyToken = require('../middlewares/authMiddleware');

router.use(verifyToken);

router.post('/', taskController.createTask);
router.get('/', taskController.getTasks);
router.put('/:id/status', taskController.updateTaskStatus);

module.exports = router;
