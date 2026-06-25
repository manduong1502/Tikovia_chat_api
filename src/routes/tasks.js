const express = require('express');
const router = express.Router();
const taskController = require('../controllers/taskController');
const verifyToken = require('../middlewares/authMiddleware');

router.use(verifyToken);

router.post('/', taskController.createTask);
router.get('/', taskController.getTasks);
router.get('/conversation/:conversationId', taskController.getConversationTasks);
router.put('/:id/status', taskController.updateTaskStatus);

module.exports = router;
