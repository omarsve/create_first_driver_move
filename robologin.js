const { get } = require('lodash');
const superagent = require('superagent');

const KRATOS_URL = process.env.KRATOS_URL;
const KRATOS_USERNAME = process.env.KRATOS_USERNAME;
const KRATOS_PASSWORD = process.env.KRATOS_PASSWORD;

const robologin = async () => { 
  console.log(`Getting flow id ${KRATOS_URL}/self-service/login/api`);
  console.log(`KRATOS_USERNAME ${KRATOS_USERNAME}`);
  console.log(`KRATOS_PASSWORD ${KRATOS_PASSWORD}`);
  try {
    const request = await superagent.get(KRATOS_URL + '/self-service/login/api').send();
    // console.log('request.body', request.body);

    const payload = {'identifier': KRATOS_USERNAME, 'password': KRATOS_PASSWORD, 'method': 'password'}
    const loginRequest = await superagent.post(get(request.body, 'ui.action', '')).send(payload);
    // console.log('loginRequest', loginRequest.body);

    return get(loginRequest.body, 'session_token', '');
  } catch (error) {
    console.log('error', error);
    res.status(500).json(error);
  }

}; 

module.exports.robologin = robologin;
