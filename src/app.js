
let Koa = require('koa');
let Router = require('koa-router');
let mount = require('koa-mount');
let render = require('./services/ejs_render');
let bodyParser = require('koa-bodyparser');
let session = require('koa-session-minimal')
let redisStore = require('koa-redis');
let path = require('path');
let MarkdownIt = require('markdown-it');
let moment = require('moment');

let config = require('./config');
let { log, SERVER } = require('./config');
let auth = require('./services/auth');
let flash = require('./services/flash');
let chelper = require('./services/chelper');

let app = new Koa();

app.use(bodyParser({
    formLimit: '10MB'
}));
render(app, {
    root: path.join(__dirname, '..', 'views'),
    layout: 'layout',
    viewExt: 'html',
    cache: false,
    debug: false
});
app.use(session({
    store: redisStore({
        url: config.REDIS_URL
    })
}));

app.use(async (ctx, next) => {
    ctx.state.md = new MarkdownIt({
        html: true
    });
    ctx.state.moment_format = function(date) {
        return moment(date).format('YYYY-MM-DD HH:mm:ssZZ');
    }
    ctx.state.moment_parse = function(date) {
        return moment(date, 'YYYY-MM-DD HH:mm:ssZZ').toDate();
    }
    await next();
});

app.use(async (ctx, next) => {
    ctx.state.current_page = "404";
    ctx.state.user = null;
    ctx.state.title = "404";
    await next();
});

let router = new Router();

router.use(require('koa-logger')());
router.use(flash);
router.use(auth.userM);
router.use(async (ctx, next) => {
    let {contest, contest_sign} = await chelper.fetchDefaultContest(ctx);
    ctx.state.latest_contest = contest;
    ctx.state.latest_contest_sign = contest_sign;
    await next();
});

router.use('', require('./controllers/index').routes());
router.use('', require('./controllers/contest').routes());
router.use('', require('./controllers/users').routes());
router.use('', require('./controllers/admin').routes());
router.use('', require('./controllers/oauth').routes());

app.use(router.routes());
app.use(require('koa-static')('public'));
app.use(async (ctx, next) => {
    await ctx.render('404', {layout: false});
});

app.listen(SERVER.PORT, SERVER.ADDRESS);

log.info(`listen on http://${SERVER.ADDRESS}:${SERVER.PORT}`);
