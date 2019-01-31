var Discord = require('discord.io');
var logger = require('winston');
var axios = require('axios');
var numeral = require('numeral');
var formatDistance = require('date-fns/formatDistance');
var Fuse = require('fuse.js');
var Redis = require('redis');

var client = Redis.createClient(process.env.REDIS_URL);

const fromTimestamp = (timestamp) => new Date(timestamp * 1000);
const getCurrentTimestamp = () => new Date().getTime() / 1000;

// Configure logger settings
logger.remove(logger.transports.Console);
logger.add(new logger.transports.Console, {
    colorize: true
});
logger.level = 'debug';
// Initialize Discord Bot
var bot = new Discord.Client({
    token: process.env.DISCORD_TOKEN,
    // autorun: true
});
bot.on('ready', function (evt) {
    logger.info('Connected');
    logger.info('Logged in as: ');
    logger.info(bot.username + ' - (' + bot.id + ')');
});

let item_list = [];
let fuse = null;
let fuse_tokenize = null;
let fuzzy_search = (s) => s.indexOf(" ") >= 0 ? fuse_tokenize.search(s) : fuse.search(s);

logger.info('Fetching Item List');

axios.get("https://api.poporing.life/get_item_list", {
    headers: {
        "Origin": "https://poporing.life",
        "User-Agent": "PoporingBot-01282019",
    }
}).then(response => {
    logger.info('Fetching List fetched');
    item_list = response.data.data.item_list.map(
        r => Object.assign(
            {},
            r,
            {
                display_name_combined: [].concat([r.display_name], r.alt_display_name_list).join("|").toLowerCase(),
            },
        )
    );
    item_list.sort((a, b) => a.display_name.length - b.display_name.length);
    var options = {
        shouldSort: true,
        tokenize: false,
        matchAllTokens: true,
        threshold: 0.6,
        location: 0,
        distance: 100,
        maxPatternLength: 32,
        minMatchCharLength: 1,
        keys: [
            "name",
            "display_name",
            "alt_display_name_list"
        ]
    };
    fuse = new Fuse(item_list, options); // "list" is the item array
    var options_tokenize = {
        shouldSort: true,
        tokenize: true,
        matchAllTokens: true,
        threshold: 0.6,
        location: 0,
        distance: 20,
        maxPatternLength: 32,
        minMatchCharLength: 1,
        keys: [
            "name",
            "display_name",
            "alt_display_name_list"
        ]
    };
    fuse_tokenize = new Fuse(item_list, options_tokenize); // "list" is the item array
    logger.info('Fuzzy Search prepared');
    bot.connect();
});

bot.on('message', function (user, userID, channelID, message, evt) {
    const dm_channel = bot.directMessages[channelID];
    const guild_id = evt.d.guild_id;
    // console.log(dm_channel);
    // console.log(guild_id);
    const check_string = "<@" + bot.id + "> ";
    const url_check_string_sea = "https://poporing.life/?search=";
    const url_check_string_glboal = "https://global.poporing.life/?search=";
    if (message.startsWith(check_string) || message.startsWith(url_check_string_sea) || message.startsWith(url_check_string_glboal) || dm_channel) {
        let server = null;
        let search_query = message.trim();
        if(message.startsWith(check_string)) {
            search_query = message.substr(check_string.length).trim();
        } else if(message.startsWith(url_check_string_sea)) {
            search_query = message.substr(url_check_string_sea.length).replace(/_/g, " ").trim();
            server = "sea";
        } else if(message.startsWith(url_check_string_glboal)) {
            search_query = message.substr(url_check_string_glboal.length).replace(/_/g, " ").trim();
            server = "global";
        }
        let query = search_query;
        const has_slash = search_query.indexOf("/");
        if (has_slash >= 0) {
            const splitted = query.split("/", 2);
            server = splitted[0].trim();
            query = splitted[1].trim();
        }
        if (!query) {
            return;
        }
        client.get('c.' + channelID, (err, res) => {
            client.get('s.' + guild_id, (err2, res2) => {

                let default_server = null;
                if (!default_server && res) default_server = res.toString();
                if (!default_server && res2) default_server = res2.toString();
                if (!default_server) default_server = "sea";

                if (!server) server = default_server;

                if (server === "s") {
                    server = "sea";
                }
                if (server === "g") {
                    server = "global";
                }

                if (query === "help") {
                    server = "cmd";
                }

                if (server === "sea" || server === "global") {
                    const from_params = query.startsWith(":");
                    const lower_search_term = query.toLowerCase();
                    let show_list = null;

                    if (from_params) {
                        show_list = item_list.filter(row => ":" + row.name === lower_search_term)[0];
                    } else {
                        show_list = item_list
                            .filter(
                                row => row.display_name_combined.indexOf(lower_search_term) >= 0
                            )[0]
                    }

                    // Do fuzzy search
                    if (!show_list) {
                        show_list = fuzzy_search(lower_search_term)[0];
                    }

                    if (!show_list) {
                        logger.info('Invalid keyword ' + query);
                        bot.sendMessage({
                            to: channelID,
                            message: query + " not found!"
                        });
                        return;
                    }
                    const item_name = show_list.name;

                    const api = "https://" + (server === "sea" ? "api" : "api-global") + ".poporing.life/get_latest_price/" + item_name;
                    const api_origin = "https://" + (server === "sea" ? "" : "global.") + "poporing.life";

                    const server_icon = server === "sea" ? "[SEA] " : "[Global] ";
                    const server_url = server === "sea" ? "https://poporing.life/?search=:" : "https://global.poporing.life/?search=:";

                    axios.get(api, {
                        headers: {
                            "Origin": api_origin,
                            "User-Agent": "PoporingBot-01282019",
                        }
                    }).then(response => {
                        // logger.info(response.data.data.data);
                        try {
                            const item_data = response.data.data.data;
                            let price = item_data.price;
                            let volume = item_data.volume;
                            let timestamp = item_data.timestamp;
                            let footnote = "";

                            if (!timestamp) {
                                price = "Unknown";
                                volume = "Unknown";
                                timestamp = "-";
                            } else {
                                if (price === 0) {
                                    if (item_data.last_known_price === 0) {
                                        price = "Unknown";
                                    } else {
                                        price = numeral(item_data.last_known_price).format("0,0");
                                        footnote = "Last Price from: " + formatDistance(fromTimestamp(item_data.last_known_timestamp), new Date());
                                    }
                                } else {
                                    price = numeral(price).format("0,0")
                                }
                                if (volume < 0) {
                                    volume = "Unknown";
                                } else {
                                    volume = numeral(volume).format("0,0")
                                }
                                timestamp = formatDistance(fromTimestamp(timestamp), new Date())
                            }

                            let image_url = show_list.image_url;
                            if (image_url) {
                                if (image_url.startsWith("http")) {

                                } else {
                                    image_url = "https://static.poporing.life/items/" + image_url;
                                }
                            } else {
                                image_url = "https://via.placeholder.com/50x50?text=?";
                            }
                            logger.info(server_icon + " " + show_list.display_name + " / Price = " + price + " / Volume = " + volume + " / Last Update " + timestamp + " / " + footnote);
                            bot.sendMessage({
                                to: channelID,
                                // message: server_icon + " " + show_list.display_name + " / Price = " + numeral(price).format("0,0") + " / Volume = " + numeral(volume).format("0,0") + " / Last Update " + formatDistance(fromTimestamp(timestamp), new Date()),
                                embed: {
                                    "description": "Price: **" + price + "** z\nVolume: **" + volume + "** ea\n\nLast Update: " + timestamp + (footnote ? "\n" + footnote : ""),
                                    "author": {
                                        "name": server_icon + " " + show_list.display_name,
                                        "url": server_url + item_name
                                    },
                                    "thumbnail": {
                                        "url": image_url,
                                    }
                                }
                            });
                        } catch (e) {
                            logger.info('Code error ');
                            logger.info(e);
                            bot.sendMessage({
                                to: channelID,
                                message: server_icon + " " + show_list.display_name + " / Server Error",
                            });
                        }
                    }).catch(e => {
                        logger.info('Server error ');
                        logger.info(e);
                        bot.sendMessage({
                            to: channelID,
                            message: server_icon + " " + show_list.display_name + " / Server Error",
                        });
                    });
                } else if (server === "cmd") {
                    switch (query) {
                        case "channel=global":
                            client.set("c." + channelID, "global");
                            bot.sendMessage({
                                to: channelID,
                                message: "Default Server for this Channel set to Global",
                            });
                            break;
                        case "channel=sea":
                            client.set("c." + channelID, "sea");
                            bot.sendMessage({
                                to: channelID,
                                message: "Default Server for this Channel set to SEA",
                            });
                            break;
                        case "default=global":
                            client.set("s." + guild_id, "global");
                            bot.sendMessage({
                                to: channelID,
                                message: "Default Server for this Discord set to Global",
                            });
                            break;
                        case "default=sea":
                            client.set("s." + guild_id, "sea");
                            bot.sendMessage({
                                to: channelID,
                                message: "Default Server for this Discord set to SEA",
                            });
                            break;
                        case "help":
                            bot.sendMessage({
                                to: channelID,
                                message: "**cmd/channel=global** Set default server for this channel to Global Server\n**cmd/channel=sea** Set default server for this channel to SEA Server\n**cmd/default=global** Set default server for this discord to Global Server\n**cmd/default=sea** Set default server for this discord to SEA Server\n",
                            });
                            break;
                    }
                } else {
                    logger.info('Invalid server ' + server);
                }
            });
        });
    }
});
bot.on('error', logger.error);