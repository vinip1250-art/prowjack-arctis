const express = require("express");
const app = express();
const catalogRouter = require("./routes/catalog");

app.use("/", catalogRouter);

app.listen(3000, () => {
  console.log("Listening on 3000");
  
  const axios = require("axios");
  axios.get("http://localhost:3000/123/catalog/movie/prowjack_rss_movie.json")
    .then(res => {
      console.log("Response:", res.data);
      process.exit(0);
    })
    .catch(err => {
      console.error(err.message);
      process.exit(1);
    });
});
