
let Router = require('koa-router');
let _ = require('lodash');
let path = require('path');
let utils = require('utility');
require('should');

let config = require('../config');
let { User, Contest, ContestSign } = require('../models');
let auth = require('../services/auth');

const router = module.exports = new Router();

// 首页
router.get('/', async (ctx, next) => {
    let contest = await Contest.findOne({public: true}).sort('-no');
    let contest_sign = null;
    if (ctx.state.user) {
        contest_sign = await ContestSign.findOne({userID: ctx.state.user._id, contestID: contest._id});
    }
    await ctx.render("index", { contest: contest, contest_sign: contest_sign, current_page: '/', title: contest.title });
});

async function ContestSignCheck(contest_id) {
    let contest = await Contest.findById(contest_id);
    auth.assert(contest, '比赛不存在');
    auth.assert(contest.begin_sign_time <= Date.now() && Date.now() <= contest.end_sign_time, '不在报名开放时间内');
    auth.assert(contest.public, '比赛未公开');

    return contest;
}

// 报名
router.get('/contests/sign', auth.loginRequired, async (ctx, next) => {
    ctx.request.query.contest_id.should.be.a.String().and.not.empty();
    ctx.request.query.user_id.should.be.a.String().and.not.empty();
    ctx.request.query.type.should.be.a.String().and.not.empty();

    auth.assert(ctx.state.normal_login, '尚未创建帐号，不能报名，前往<a href="/modify">创建帐号</a>');
    auth.assert(ctx.state.user.email_passed, '尚未关联邮箱，不能报名，前往<a href="/modify">关联邮箱</a>');
    auth.assert(ctx.state.user.info_filled, '基本信息不完善，不能报名，前往<a href="/modify">完善基本信息</a>');
    auth.assert(_.includes(['div1', 'div2'], ctx.request.query.type), '报名类型不正确');

    let contest = await ContestSignCheck(ctx.request.query.contest_id);

    let contest_sign = await ContestSign.findOne({userID: ctx.state.user._id, contestID: contest._id});
    auth.assert(!contest_sign, '已报名');

    await ContestSign.create({
        userID: ctx.state.user._id,
        contestID: contest._id,
        type: ctx.request.query.type,
    });
    ctx.state.flash.success = `报名成功，比赛网站为<a href="https://oj.thusaac.org" target="_blank">https://oj.thusaac.org</a>，可以在<a href="/modify">个人资料</a>页面查看登录密码，比赛开始前1个小时可以登录比赛网站。`;
    await ctx.redirect('back');
});

// 取消报名
router.get('/contests/unsign', auth.loginRequired, async (ctx, next) => {
    ctx.request.query.contest_id.should.be.a.String().and.not.empty();
    ctx.request.query.user_id.should.be.a.String().and.not.empty();

    let contest = await ContestSignCheck(ctx.request.query.contest_id);

    let contest_sign = await ContestSign.findOne({userID: ctx.state.user._id, contestID: contest._id});
    auth.assert(contest_sign, '未报名');

    await contest_sign.remove();
    ctx.state.flash.success = "取消报名成功";
    await ctx.redirect('back');
});

// TODO: administrative interface
