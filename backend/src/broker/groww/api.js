"use strict";

const axios = require("axios");
const config = require("../config/config");

module.exports = axios.create({
    baseURL: config.groww.baseUrl,
    timeout: 30000,
    headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-API-VERSION": "1.0",
    },
});