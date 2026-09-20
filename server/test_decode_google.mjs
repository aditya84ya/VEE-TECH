import axios from 'axios';

async function run() {
  const url = 'https://news.google.com/rss/articles/CBMimgFBVV95cUxNdFE3UjZHX2Y3ZTRxNjRySDBxZUFEbHhIa1JicExzcENuUHBmWGItYU14elJqYWJvWlY4b2hrSWluci1xZnZiVjhYcmE1a2VBY2pwWDJmWE9HSlpBVnFYaFBtOFdRU0ZPMThQcFM1OXRMUy1EalFFd01Rb1Aydm03WjhSbW1felFiWUdIeUZ1UVIxQVlGdGJpSkNn?oc=5';
  const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const regex = new RegExp('https?:\\/\\/[^\\s"\'<\\\\]*yahoo[^\\s"\'<\\\\]*', 'g');
  const matches = res.data.match(regex);
  console.log('Matches:', matches);
}
run();
