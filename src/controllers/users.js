
let Router = require('koa-router');
let _ = require('lodash');
let path = require('path');
let utils = require('utility');
let qs = require('querystring');
let request = require('superagent');
let moment = require('moment');
require('should');

let config = require('../config');
let { User, Contest, ContestSign, MDB } = require('../models');
let { EMailBlacklist } = require('../models');
let auth = require('../services/auth');
let tools = require('../services/tools');
let email = require('../services/email');
let chelper = require('../services/chelper');

const router = module.exports = new Router();

// 注册
router.get('/register', async (ctx, next) => {
    await ctx.render("register", {layout: 'user_layout', title: "注册"});
});
router.post('/register', async (ctx, next) => {
    ctx.request.body.username.should.be.a.String().and.not.eql("","请填写用户名");
    ctx.request.body.password.should.be.a.String().and.not.eql("","请填写密码");
    await auth.register(ctx, ctx.request.body.username, ctx.request.body.password);
    ctx.state.flash.success = '注册成功';
    ctx.state.flash.warning = `请尽快<a href="/modify">验证邮箱</a>，便于找回密码`;
    await ctx.redirect('/');
});

// 登录
router.get('/login', async (ctx, next) => {
    await ctx.render("login", {layout: 'user_layout', title: "登录", OAUTH: config.OAUTH, URL_PREFIX: config.SERVER.URL_PREFIX});
});
router.post('/normal_login', async (ctx, next) => {
    ctx.request.body.username.should.be.a.String().and.not.eql("","请填写用户名");
    ctx.request.body.password.should.be.a.String().and.not.eql("","请填写密码");
    await auth.normal_login(ctx, ctx.request.body.username, ctx.request.body.password);
    ctx.state.flash.success = '登录成功';
    let login_redirect_url = ctx.session.login_redirect_url;
    ctx.session.login_redirect_url = null;
    await ctx.redirect(login_redirect_url || '/');
});
router.post('/salt_login', async (ctx, next) => {
    ctx.request.body.username.should.be.a.String().and.not.eql("","请填写用户名");
    ctx.request.body.password.should.be.a.String().and.not.eql("","请填写密码");
    await auth.salt_login(ctx, ctx.request.body.username, ctx.request.body.password);
    ctx.state.flash.success = '登录成功';
    let login_redirect_url = ctx.session.login_redirect_url;
    ctx.session.login_redirect_url = null;
    await ctx.redirect(login_redirect_url || '/');
});
router.get('/github_callback', async (ctx, next) => {
    ctx.request.query.code.should.be.a.String().and.not.empty();
    
    let res = (await request.post('https://github.com/login/oauth/access_token')
        .send({
            client_id: config.OAUTH.GITHUB.CLIENT_ID,
            client_secret: config.OAUTH.GITHUB.CLIENT_SECRET,
            code: ctx.request.query.code,
            redirect_uri: config.SERVER.URL_PREFIX + '/github_callback'
        })).body;
    let info = (await request.get('https://api.github.com/user').query(res)).body;
    await auth.github_login(ctx, info);
    ctx.state.flash.success = '登录成功';
    let login_redirect_url = ctx.session.login_redirect_url;
    ctx.session.login_redirect_url = null;
    await ctx.redirect(login_redirect_url || '/');
});
router.get('/logout', async (ctx, next) => {
    await auth.logout(ctx);
    ctx.state.flash.success = '登出成功';
    await ctx.redirect("/");
});

// 忘记密码
router.get('/forgot_password', async (ctx, next) => {
    await ctx.render("forgot_password", {layout: 'user_layout', title: "忘记密码"});
});
router.get('/forgot_password_sendemail', async (ctx, next) => {
    ctx.request.query.email.should.be.a.String().and.not.eql("","请填写邮箱");

    let user = await User.findOne({email: ctx.request.query.email});
    auth.assert(user, "不存在与该邮箱关联的用户");
    auth.assert(!user.forgot_password_last_send_time
            || moment(user.forgot_password_last_send_time).add(moment.duration(1, 'minutes')).toDate() < Date.now(), '请1分钟之后再发送邮件');

    user.forgot_password_last_send_time = Date.now();
    user.forgot_password_code = utils.randomString(10, '1234567890');
    user.forgot_password_code_expire = moment().add(moment.duration(10, 'minutes')).toDate(); // 10分钟
    await user.save();

    await email.sendForgotEmail(user);
    ctx.state.flash.success = "邮件发送成功";

    await ctx.redirect('/forgot_password2?' + qs.stringify({email: ctx.request.query.email}));
});
router.get('/forgot_password2', async (ctx, next) => {
    ctx.request.query.email.should.be.a.String().and.not.eql("", "喵喵，你在做什么呀？");

    await ctx.render("forgot_password2", {layout: 'user_layout', title: "忘记密码", email: ctx.request.query.email});
});
router.post('/forgot_password_reset', async (ctx, next) => {
    ctx.request.body.email.should.be.a.String().and.not.empty();
    ctx.request.body.code.should.be.a.String().and.not.eql("", "请填写验证码");
    ctx.request.body.password.should.be.a.String().and.not.eql("","请填写密码");

    let user = await User.findOne({email: ctx.request.body.email});
    auth.assert(user, "用户不存在");
    auth.assert(user.forgot_password_code_expire > Date.now(), "验证码已过期");
    auth.assert(user.forgot_password_code == ctx.request.body.code, "验证码不正确"); // 允许多次尝试

    await user.save();

    await auth.resetPassword(ctx, user, ctx.request.body.password);
    ctx.state.flash.success = "重置密码成功";
    await ctx.redirect('/');
});

// 修改资料
router.get('/modify', auth.loginRequired, async (ctx, next) => {
    let blocked = ctx.state.user.email && await EMailBlacklist.findOne({email: ctx.state.user.email});
    await ctx.render('modify', {current_page: 'modify', title: "修改资料", blocked: blocked});
});
// 修改昵称
router.post('/modify_nickname', auth.loginRequired, async (ctx, next) => {
    ctx.request.body.nickname.should.be.a.String().and.not.eql("","昵称不能为空");

    let already_one = await User.findOne({nickname: ctx.request.body.nickname});
    auth.assert(!already_one || already_one._id.equals(ctx.state.user._id), '昵称已存在');

    ctx.state.user.nickname = ctx.request.body.nickname;
    await ctx.state.user.save();
    ctx.state.flash.success = "昵称修改成功";

    await ctx.redirect('back');
});
// 修改邮箱
router.post('/modify_email', auth.loginRequired, async (ctx, next) => {
    ctx.request.body.email.should.be.a.String().and.not.eql("","请填入邮箱");
    let user = ctx.state.user;
    auth.assert(ctx.state.normal_login, "请先创建帐号密码");

    tools.emailFormatCheck(ctx.request.body.email);
    let already_user = await User.findOne({email: ctx.request.body.email});
    auth.assert(!already_user || already_user._id.equals(ctx.state.user._id), '该邮箱已关联其他用户');
    auth.assert(!user.email_last_send_time
        || moment(user.email_last_send_time).add(moment.duration(1, 'minutes')).toDate() < Date.now(), '请1分钟之后再发送邮件');
    user.email_will = ctx.request.body.email;
    user.email_code = utils.randomString(10, '1234567890');
    user.email_code_expire = moment().add(moment.duration(10, 'minutes')).toDate(); // 10分钟后过期
    user.email_last_send_time = Date.now();
    await user.save();

    await email.sendActiveEmail(user);
    await ctx.redirect('/email_sent');
});

router.get('/email_sent', auth.loginRequired, async (ctx, next) => {
    await ctx.render('email_sent', {current_page: 'modify', title: "验证邮箱"});
});

router.get('/resend_email', auth.loginRequired, async (ctx, next) => {
    let user = ctx.state.user;
    auth.assert(ctx.state.normal_login, "请先创建帐号密码");
    auth.assert(user.email_will, '坏心眼的小不点');

    auth.assert(!user.email_last_send_time
        || moment(user.email_last_send_time).add(moment.duration(1, 'minutes')).toDate() < Date.now(), '请1分钟之后再发送邮件');

    user.email_code = utils.randomString(10, '1234567890');
    user.email_code_expire = moment().add(moment.duration(10, 'minutes')).toDate(); // 10分钟后过期
    user.email_last_send_time = Date.now();
    await user.save();

    await email.sendActiveEmail(user);
    ctx.state.flash.success = "重新发送邮件成功";

    await ctx.redirect('back');
});
router.get('/check_email_code', async (ctx, next) => {
    ctx.request.query.code.should.be.a.String().and.not.empty();
    ctx.request.query.user_id.should.be.a.String().and.not.empty();

    let user = await User.findById(ctx.request.query.user_id);
    auth.assert(user, "用户不存在");
    auth.assert(user.email_code_expire > Date.now(), "已过期");
    auth.assert(user.email_code == ctx.request.query.code, "验证码不正确");

    let already_user = await User.findOne({email: user.email_will});
    auth.assert(!already_user || already_user._id.equals(ctx.state.user._id), '该邮箱已关联其他用户');

    user.email = user.email_will;
    user.email_passed = true;
    await user.save();

    ctx.state.flash.success = "邮箱激活成功";
    await ctx.redirect("/");
});
// 修改资料
router.post('/modify_info', auth.loginRequired, async (ctx, next) => {
    let FIELDS = {
      real_name: "真实姓名",
      school: "学校",
      grade: "年级",
      major: "专业",
      sex: "性别",
      phone_number: "电话号码",
      tshirt_size: "衣服尺寸",
    };

    for(const v in FIELDS)
        ctx.request.body[v].should.be.a.String().and.not.eql("", `${FIELDS[v]}不能为空`);

    _.assign(ctx.state.user, _.pick(ctx.request.body, Object.keys(FIELDS)));
    ctx.state.user.info_filled = true;
    await ctx.state.user.save();
    ctx.state.flash.success = '资料修改成功';
    await ctx.redirect('back');
});
//修改快递信息
router.post('/modify_express', auth.loginRequired, async (ctx, next) => {
    let FIELDS = {
      receiver: '收件人',
      phone: '收件人电话',
      prov: '省',
      city: '市',
      county: '县',
      addr: '详细地址',
    };

    for(const v in FIELDS)
        ctx.request.body[v].should.be.a.String().and.not.eql("", `${FIELDS[v]}不能为空`);
    
    let {contest, contest_sign} = await chelper.fetchExpressContest(ctx);
    auth.assert(contest && contest_sign && contest_sign.has_award, '抱歉,你没有获奖');

    auth.assert(!contest.express_info_end, '快递填写已结束，请联系管理员');

    _.assign(contest_sign, _.pick(ctx.request.body, Object.keys(FIELDS)));
    contest_sign.express_info_filled = true;
    await contest_sign.save();
    
    ctx.state.flash.success = '快递信息修改成功';
    await ctx.redirect('back');
});
// 全国地图信息
router.get('/express_mdb', async (ctx, next) => {
    ctx.request.query.level.should.be.a.String().and.not.empty();
    let cond = {
        level: ctx.request.query.level
    };
    if (ctx.request.query.parentId) cond.parentId = ctx.request.query.parentId;
    let arr = await MDB.find(cond);
    ctx.body = arr.map(x => x.toJSON());
});
// 创建帐号
router.post('/create_account', auth.loginRequired, async (ctx, next) => {
    ctx.request.body.username.should.be.a.String().and.not.eql("","请填入用户名");
    ctx.request.body.password.should.be.a.String().and.not.eql("","请填入密码");
    await auth.createAccount(ctx, ctx.request.body.username, ctx.request.body.password);
    ctx.state.flash.success = '创建帐号成功';
    await ctx.redirect('back');
});
// 修改密码
router.post('/modify_password', auth.loginRequired, async (ctx, next) => {
    ctx.request.body.password.should.be.a.String().and.not.eql("","请填入密码");
    await auth.modifyPassword(ctx, ctx.request.body.password);
    ctx.state.flash.success = '修改密码成功';
    await ctx.redirect('back');
});

router.get('/submit_code', auth.loginRequired, async (ctx, next) => {
    await ctx.render('submit_code', {layout: false});
});

router.post('/submit_code', auth.loginRequired, async (ctx, next) => {
    ctx.state.flash.error = "无法提交";
    return await ctx.redirect('/');

    for(let i = 1; i <= 6; i ++) {
        let name = `T${i}_code`;
        if (ctx.request.body[name] && ctx.request.body[name].length > 10) {
            ctx.state.user[name] = ctx.request.body[name];
        }
    }
    await ctx.state.user.save();
    await ctx.redirect('/submit_code');
});