const axios = require("axios");

async function test() {

    try {

        console.log("Testing Server...\n");

        const health = await axios.get("http://127.0.0.1:4000/health");

        console.log("Health:");
        console.log(health.data);

        console.log("\nAngel Holdings:");

        const holdings = await axios.get(
            "http://127.0.0.1:4000/api/angelone/holdings"
        );

        console.log(holdings.data);

    } catch (err) {

        console.log("ERROR");

        console.log(err.response?.data || err.message);

    }

}

test();