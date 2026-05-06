require('dotenv').config();
const express = require('express');
const path = require('path');
const analyzeHandler = require('./api/analyze');

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.post('/api/analyze', analyzeHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running at http://localhost:${PORT}`));
