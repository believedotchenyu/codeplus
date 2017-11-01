
let Router = require('koa-router');
let _ = require('lodash');
let path = require('path');
let utils = require('utility');
require('should');

let config = require('../config');
let { User } = require('../models');
let auth = require('../services/auth');
let tools = require('../services/tools');
let email = require('../services/email');

const router = module.exports = new Router();

// 注册
router.get('/register', async (ctx, next) => {
    await ctx.render("register", {layout: false});
});
router.post('/register', async (ctx, next) => {
    ctx.request.body.username.should.be.a.String().and.not.empty();
    ctx.request.body.password.should.be.a.String().and.not.empty();
    await auth.register(ctx, ctx.request.body.username, ctx.request.body.password);
    ctx.state.flash.success = '注册成功';
    ctx.state.flash.warning = `请尽快<a href="/modify">验证邮箱</a>，便于找回密码`;
    await ctx.redirect('/');
});

// 登录
router.get('/login', async (ctx, next) => {
    await ctx.render("login", {layout: false});
});
router.post('/normal_login', async (ctx, next) => {
    ctx.request.body.username.should.be.a.String().and.not.empty();
    ctx.request.body.password.should.be.a.String().and.not.empty();
    await auth.normal_login(ctx, ctx.request.body.username, ctx.request.body.password);
    ctx.state.flash.success = '登录成功';
    await ctx.redirect('/');
});
router.get('/logout', async (ctx, next) => {
    await auth.logout(ctx);
    ctx.state.flash.success = '登出成功';
    await ctx.redirect("/");
});

// 修改资料
router.get('/modify', auth.loginRequired, async (ctx, next) => {
    await ctx.render('modify', {current_page: 'modify'});
});
// 修改昵称
router.post('/modify_nickname', auth.loginRequired, async (ctx, next) => {
    ctx.request.body.nickname.should.be.a.String().and.not.empty();

    ctx.state.user.nickname = ctx.request.body.nickname;
    await ctx.state.user.save();
    ctx.state.flash.success = "昵称修改成功";

    await ctx.redirect('back');
});
// 修改邮箱
router.post('/modify_email', auth.loginRequired, async (ctx, next) => {
    ctx.request.body.email.should.be.a.String().and.not.empty();
    let user = ctx.state.user;

    tools.emailFormatCheck(ctx.request.body.email);
    let already_user = await User.findOne({email: ctx.request.body.email});
    auth.assert(!already_user || already_user._id.equals(ctx.state.user._id), '该邮箱已关联其他用户');
    user.email_will = ctx.request.body.email;
    user.email_code = utils.randomString(10, '1234567890');
    user.email_code_expire = Date.now() + 10 * 60 * 1000; // 10分钟后过期
    await user.save();

    await email.sendActiveEmail(user);
    await ctx.redirect('/email_sended');
});
router.get('/email_sended', auth.loginRequired, async (ctx, next) => {
    await ctx.render('email_sended', {current_page: 'modify'});
});
router.get('/resend_email', auth.loginRequired, async (ctx, next) => {
    let user = ctx.state.user;

    user.email_code = utils.randomString(10, '1234567890');
    user.email_code_expire = Date.now() + 10 * 60 * 1000; // 10分钟后过期
    await user.save();

    await email.sendActiveEmail(user);
    ctx.state.flash.success = "重新发送邮件成功";

    await ctx.redirect('back');
});
router.get('/check_email_code', auth.loginRequired, async (ctx, next) => {
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
    let FIEDS = ['real_name', 'school', 'sex', 'phone_number'];
    FIEDS.forEach((v) => {
        ctx.request.body[v].should.be.a.String().and.not.empty();
    });
    _.assign(ctx.state.user, _.pick(ctx.request.body, FIEDS));
    ctx.state.user.info_filled = true;
    await ctx.state.user.save();
    ctx.state.flash.success = '资料修改成功';
    await ctx.redirect('back');
});
// 修改密码
router.post('/modify_password', auth.loginRequired, async (ctx, next) => {
    ctx.request.body.password.should.be.a.String().and.not.empty();
    await auth.modifyPassword(ctx, ctx.request.body.password);
    ctx.state.flash.success = '修改密码成功';
    await ctx.redirect('back');
});