const fs = require("fs");
const s = fs.readFileSync(__dirname + "/../site/assets/app.css", "utf8");
const open = (s.match(/\{/g) || []).length;
const close = (s.match(/\}/g) || []).length;
console.log("css braces open", open, "close", close, open === close ? "BALANCED" : "MISMATCH");
const j = fs.readFileSync(__dirname + "/../site/assets/app.js", "utf8");
const jopen = (j.match(/\{/g) || []).length;
const jclose = (j.match(/\}/g) || []).length;
console.log("js braces open", jopen, "close", jclose, jopen === jclose ? "BALANCED" : "MISMATCH");