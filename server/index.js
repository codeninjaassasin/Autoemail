const express = require('express');
const path = require('path');
const config = require('./config');

const oauthGoogle = require('./routes/oauthGoogle');
const oauthMicrosoft = require('./routes/oauthMicrosoft');
const accounts = require('./routes/accounts');
const drafts = require('./routes/drafts');
const research = require('./routes/research');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/oauth/google', oauthGoogle);
app.use('/oauth/microsoft', oauthMicrosoft);
app.use('/api/accounts', accounts);
app.use('/api/drafts', drafts);
app.use('/api/research', research);

app.listen(config.port, () => {
  console.log(`Autoemail running at ${config.baseUrl}`);
});
