
let Router = require('koa-router');
let _ = require('lodash');
let path = require('path');
let utils = require('utility');
let qs = require('querystring');
let request = require('superagent');
let moment = require('moment');
let iconv = require('iconv-lite');
let mzfs = require('mz/fs');
require('should');

let body = require('koa-convert')(require('koa-better-body')());

let config = require('../config');
let { User, NormalLogin, Contest, ContestSign, OauthAPP, Count } = require('../models');
let { EMailTemplate, EMailToSend, EMailBlacklist } = require('../models');
let { Feedback } = require('../models');
let auth = require('../services/auth');
let tools = require('../services/tools');
let email = require('../services/email');
let chelper = require('../services/chelper');

const router = module.exports = new Router();

router.get('/admin', auth.adminRequired, async (ctx, next) => {
    let contests = await Contest.find().sort('-no');
    await ctx.render("admin_contests", {layout: 'admin_layout', contests: contests});
});
router.get('/admin/contests/:contest_id', auth.adminRequired, async (ctx, next) => {
    ctx.params.contest_id.should.be.a.String().and.not.empty();

    let contest = await Contest.findById(ctx.params.contest_id);
    auth.assert(contest, '比赛不存在');

    let award_signs = await ContestSign.find({contestID: contest._id, has_award: true});
    let award_logins = await NormalLogin.find({userID: award_signs.map(x => {return x.userID;})});
    let award_names = award_logins.map(x => {return x.username;});

    tools.bindFindByXX(award_logins, 'userID');
    let price_info = [];
    for(let x of award_signs) {
        if (x.express_no) {
            price_info.push([award_logins.findByuserID(x.userID).username, x.express_name, x.express_no, x.prize_name]);
        }
    }

    let rating_signs = await ContestSign.find({contestID: contest._id});
    let rating_logins = await NormalLogin.find({userID: rating_signs.map(x => {return x.userID;})});

    let rating_info = [];
    tools.bindFindByXX(rating_logins, 'userID');
    for(let x of rating_signs) {
        if (x.rating_before) {
            rating_info.push([rating_logins.findByuserID(x.userID).username, x.rating_before, x.rating_now, x.rating_delta]);
        }
    }

    await ctx.render('admin_contest', {
        layout: 'admin_layout',
        contest: contest,
        award_names: award_names,
        price_info: price_info,
        rating_info: rating_info
    });
});
router.post('/admin/contests/create_contest', auth.adminRequired, async (ctx, next) => {
    let c = new Contest();
    c.begin_sign_time = c.end_sign_time = c.begin_contest_time = c.end_contest_time = Date.now();

    await c.save();
    
    await ctx.redirect('back');
});
router.post('/admin/contests/:contest_id', auth.adminRequired, async (ctx, next) => {
    ctx.params.contest_id.should.be.a.String().and.not.empty();
    let info = ctx.request.body;
    info.public = info.public ? true : false;
    info.express_info_end = info.express_info_end ? true : false;

    let contest = await Contest.findById(ctx.params.contest_id);
    auth.assert(contest, '比赛不存在');
    _.assign(contest, _.pick(info, [
        'no', 'public', 'express_info_end',
        'begin_sign_time', 'end_sign_time', 'begin_contest_time', 'end_contest_time',
        'title',
        'description', 'terms',
        'repository_local_name',
        'rank_msg',
    ]));
    await contest.save();

    contest.contests = info.contests.split(',').map(x => _.trim(x)).filter(x => x.length > 0);

    for(let type of _.concat(contest.contests, 'practise')) {
        let name = `${type}_contest_id`;
        contest.contest_ids[type] = null;
        if (info[name] && _.trim(info[name]).length > 0) contest.contest_ids[type] = Number(_.trim(info[name]));
    }
    contest.markModified('contest_ids');
    await contest.save();

    let ranked_count = {};
    for(let type of contest.contests) {
        await ContestSign.update({contestID: contest._id, type: type}, {$set: {rank: null}}, {multi: true});
        ranked_count[type] = -1;

        let ranklist = ctx.request.body[`${type}_ranklist`];
        if (!ranklist || _.trim(ranklist).length == 0) continue;
        let lines = _.trim(ranklist).split('\n').map(x => {return _.split(_.trim(x), '\t')});

        ranked_count[type] = 0;
        let rank_index = _.indexOf(lines[0], 'rank');
        let id_index = _.indexOf(lines[0], 'id');
        for(let i = 1; i < lines.length; i ++) {
            auth.assert(lines[i].length == lines[0].length, `${type} ranklist第${i+1}行长度不符`);
            if (rank_index >= 0 && id_index >= 0) {
                let rank = Number(lines[i][rank_index]);
                let username = lines[i][id_index];
                let login = await NormalLogin.findOne({username: username});
                if (login) {
                    let rst = await ContestSign.update({contestID: contest._id, type: type, userID: login.userID}, {$set: {rank}});
                    ranked_count[type] += rst.nModified;
                }
            }
        }

        contest.ranklist[type] = lines.map(x => {return x.join('\t')}).join('\n');
    }
    contest.markModified('ranklist');
    await contest.save();

    ctx.state.flash.success = `更新成功,` + _.keys(ranked_count).map(x => `${x}有效排名${ranked_count[x]}个`).join(',');

    await ctx.redirect('back');
});
router.get('/admin/contests/:contest_id/preview', auth.adminRequired, async (ctx, next) => {
    ctx.params.contest_id.should.be.a.String().and.not.empty();

    let contest = await Contest.findById(ctx.params.contest_id);
    auth.assert(contest, '比赛不存在');

    await ctx.render('admin_contest_preview', {layout: 'admin_layout', contest: contest});
});
// 新建公告
router.post('/admin/contests/:contest_id/create_notice', auth.adminRequired, async (ctx, next) => {
    ctx.request.body.title.should.be.a.String().and.not.empty();
    ctx.request.body.content.should.be.a.String().and.not.empty();

    let hidden_names = [];
    if (ctx.request.body.hidden_names)
    {
        hidden_names = ctx.request.body.hidden_names.split(',').map(x => _.trim(x));
    }

    let contest = await Contest.findById(ctx.params.contest_id);
    auth.assert(contest, '比赛不存在');

    contest.notices = contest.notices || [];
    contest.notices.splice(0, 0, {
        title: ctx.request.body.title,
        content: ctx.request.body.content,
        hidden_names: hidden_names,
        datetime: Date.now()
    });
    await contest.save();

    ctx.state.flash.success = `新建公告成功`;
    await ctx.redirect('back');
});
// 修改公告
router.post('/admin/contests/:contest_id/modify_notice', auth.adminRequired, async (ctx, next) => {
    ctx.request.query.notice_id.should.be.a.String().and.not.empty();
    ctx.request.body.title.should.be.a.String().and.not.empty();
    ctx.request.body.content.should.be.a.String().and.not.empty();

    let hidden_names = [];
    if (ctx.request.body.hidden_names)
    {
        hidden_names = ctx.request.body.hidden_names.split(',').map(x => _.trim(x));
    }

    let contest = await Contest.findById(ctx.params.contest_id);
    auth.assert(contest, '比赛不存在');

    auth.assert(contest.notices, '没有公告');
    let notice = await contest.notices.id(ctx.request.query.notice_id);
    auth.assert(notice, '公告不存在');
    _.assign(notice, _.pick(ctx.request.body, ['title', 'content']));
    notice.hidden_names = hidden_names;
    await contest.save();

    ctx.state.flash.success = `修改公告成功`;
    await ctx.redirect('back');
});
// 删除公告
router.get('/admin/contests/:contest_id/delete_notice', auth.adminRequired, async (ctx, next) => {
    ctx.request.query.notice_id.should.be.a.String().and.not.empty();

    let contest = await Contest.findById(ctx.params.contest_id);
    auth.assert(contest, '比赛不存在');

    auth.assert(contest.notices, '没有公告');
    let notice = await contest.notices.id(ctx.request.query.notice_id);
    auth.assert(notice, '公告不存在');
    notice.remove();
    await contest.save();

    ctx.state.flash.success = `删除公告成功`;
    await ctx.redirect('back');
});
router.post('/admin/contests/:contest_id/update_award', auth.adminRequired, async (ctx, next) => {
    ctx.params.contest_id.should.be.a.String().and.not.empty();
    ctx.request.body.userlist.should.be.a.String().and.not.empty();

    let contest = await Contest.findById(ctx.params.contest_id);
    auth.assert(contest, '比赛不存在');

    await ContestSign.update({contestID: contest._id}, {$set: {has_award: false}}, {multi: true});
    let names = ctx.request.body.userlist.split('\n').map(x => {return _.trim(x);});
    let logins = await NormalLogin.find({username: names});
    await ContestSign.update({contestID: contest._id, userID: logins.map(x => {return x.userID})}, {$set: {has_award: true}}, {multi: true});

    ctx.state.flash.success = `有${logins.length}人获奖`;
    await ctx.redirect('back');
});
router.post('/admin/contests/:contest_id/update_price_info', auth.adminRequired, async (ctx, next) => {
    ctx.params.contest_id.should.be.a.String().and.not.empty();
    let price_info = ctx.request.body.price_info;
    price_info.should.be.a.String();

    let contest = await Contest.findById(ctx.params.contest_id);
    auth.assert(contest, '比赛不存在');

    await ContestSign.update({contestID: contest._id}, {$set: {prize_name: null, express_name: null, express_no: null}}, {multi: true});
    
    if (price_info.trim().length != 0) {
        let lines = price_info.trim().split('\n').map(x => _.trim(x));
        for(let line of lines) {
            let tokens = line.split('\t');
            tokens.should.have.lengthOf(4);
            let [username, express_name, express_no, prize_name] = tokens;
            let login = await NormalLogin.findOne({username});
            auth.assert(login, `用户${username}不存在`);
            let sign = await ContestSign.findOne({contestID: contest._id, userID: login.userID});
            auth.assert(sign, `用户${username}未报名`);
            _.assign(sign, {express_name, express_no, prize_name});
            await sign.save();
        }
        ctx.state.flash.success = `共更新${lines.length}人的获奖信息`;
    } else {
        ctx.state.flash.success = `清空获奖信息`;
    }
    
    await ctx.redirect('back');
});
router.post('/admin/contests/:contest_id/update_rating_info', auth.adminRequired, async (ctx, next) => {
    ctx.params.contest_id.should.be.a.String().and.not.empty();
    let rating_info = ctx.request.body.rating_info;
    rating_info.should.be.a.String();

    let contest = await Contest.findById(ctx.params.contest_id);
    auth.assert(contest, '比赛不存在');

    await ContestSign.update({contestID: contest._id}, {$set: {rating_before: null, rating_now: null, rating_delta: null}}, {multi: true});
    
    if (rating_info.trim().length != 0) {
        let lines = rating_info.trim().split('\n').map(x => _.trim(x));
        for(let line of lines) {
            let tokens = line.split('\t');
            tokens.should.have.lengthOf(4);
            let [username, rating_before, rating_now, rating_delta] = tokens;
            let login = await NormalLogin.findOne({username});
            auth.assert(login, `用户${username}不存在`);
            let sign = await ContestSign.findOne({contestID: contest._id, userID: login.userID});
            auth.assert(sign, `用户${username}未报名`);
            _.assign(sign, {rating_before, rating_now, rating_delta});
            await sign.save();

            let user = await User.findById(login.userID);
            user.rating = rating_now;
            await user.save();
        }
        ctx.state.flash.success = `共更新${lines.length}人的Rating`;
    } else {
        ctx.state.flash.success = `清空获奖信息`;
    }
    
    await ctx.redirect('back');
});
router.get('/admin/contests/:contest_id/express_info', auth.adminRequired, async (ctx, next) => {
    ctx.params.contest_id.should.be.a.String().and.not.empty();

    let contest = await Contest.findById(ctx.params.contest_id);
    auth.assert(contest, '比赛不存在');

    let express_lines = await chelper.fetchContestExpressInfo(contest);

    let total_count = await ContestSign.find({contestID: contest._id, has_award: true}).count();
    let filled_count = await ContestSign.find({contestID: contest._id, has_award: true, express_info_filled: true}).count();
    let unfilled_count = total_count - filled_count;

    await ctx.render('admin_contest_express_info', {layout: 'admin_layout',
        contest: contest, express_lines: express_lines,
        total_count: total_count, filled_count: filled_count, unfilled_count: unfilled_count
    });
});
router.get('/admin/contests/:contest_id/express_info_download', auth.adminRequired, async (ctx, next) => {
    ctx.params.contest_id.should.be.a.String().and.not.empty();

    let contest = await Contest.findById(ctx.params.contest_id);
    auth.assert(contest, '比赛不存在');

    ctx.set("Content-Disposition", "attachment; filename=" + qs.escape(contest.title+"-快递信息") + ".csv" );
    let lines = await chelper.fetchContestExpressInfo(contest);
    let content = lines.map(x => {return x.join(',')}).join('\n') + '\n';
    if (ctx.request.query.encoding) {
        content = iconv.encode(content, ctx.request.query.encoding);
    }
    ctx.body = content;
});
router.get('/admin/contests/:contest_id/signs_info', auth.adminRequired, async (ctx, next) => {
    ctx.params.contest_id.should.be.a.String().and.not.empty();

    let contest = await Contest.findById(ctx.params.contest_id);
    auth.assert(contest, '比赛不存在');

    let signs_lines = await chelper.fetchContestSignsInfo(contest);

    await ctx.render('admin_contest_signs_info', {layout: 'admin_layout',
        contest: contest, signs_lines: signs_lines
    });
});
router.get('/admin/contests/:contest_id/signs_info_download', auth.adminRequired, async (ctx, next) => {
    ctx.params.contest_id.should.be.a.String().and.not.empty();

    let contest = await Contest.findById(ctx.params.contest_id);
    auth.assert(contest, '比赛不存在');

    ctx.set("Content-Disposition", "attachment; filename=" + qs.escape(contest.title+"-报名信息") + ".csv" );
    let lines = await chelper.fetchContestSignsInfo(contest);
    let content = lines.map(x => {return x.join(',')}).join('\n') + '\n';
    if (ctx.request.query.encoding) {
        content = iconv.encode(content, ctx.request.query.encoding);
    }
    ctx.body = content;
});
router.get('/admin/contests/:contest_id/signs_pass_download', auth.adminRequired, async (ctx, next) => {
    ctx.params.contest_id.should.be.a.String().and.not.empty();

    let contest = await Contest.findById(ctx.params.contest_id);
    auth.assert(contest, '比赛不存在');

    let pass_lines = await chelper.fetchContestPassInfo(contest);

    ctx.set("Content-Disposition", "attachment; filename=pass.txt");
    let content = pass_lines.map(x => x.join(' ')).join('\n');
    if (ctx.request.query.encoding) {
        content = iconv.encode(content, ctx.request.query.encoding);
    }
    ctx.body = content;
});

router.get('/admin/contests/:contest_id/signs_statistic', auth.adminRequired, async (ctx, next) => {
    ctx.params.contest_id.should.be.a.String().and.not.empty();

    let contest = await Contest.findById(ctx.params.contest_id);
    auth.assert(contest, '比赛不存在');

    let counts = {};
    for(let type of contest.contests) {
        counts[type] = await Count.find({name: `contest_${type}_signs:${contest._id}`});
    }

    let nums = {};
    nums.users = await User.count();
    for(let type of contest.contests) {
        nums[`${type}_signs`] = await ContestSign.find({contestID: contest._id, type: type}).count();
    }
    nums.total_signs = await ContestSign.find({contestID: contest._id}).count();

    await ctx.render('admin_contest_signs_statistic', {layout: 'admin_layout',
        contest: contest, counts: counts, nums: nums
    });
});

// oauth
router.get('/admin/oauth', auth.adminRequired, async (ctx, next) => {
    let apps = await OauthAPP.find();
    await ctx.render('admin_oauth', {layout: 'admin_layout', apps: apps});
});
router.post('/admin/oauth/create', auth.adminRequired, async (ctx, next) => {
    ctx.request.body.description.should.be.a.String().and.not.empty();

    let app_id = null;
    while(true) {
        app_id = utils.randomString(32, '1234567890qwertyuioplkjhgfdsazxcvbnm');
        if (!await OauthAPP.findOne({app_id})) break;
    }
    await OauthAPP.create({
        app_id: app_id,
        app_secret: utils.randomString(48, '1234567890qwertyuioplkjhgfdsazxcvbnm'),
        description: ctx.request.body.description,
        contest_info_accessable: ctx.request.body.contest_info_accessable,
    });
    ctx.state.flash.success = "创建OAUTH应用成功";
    await ctx.redirect('back');
});
router.get('/admin/oauth/:oauth_id/delete', auth.adminRequired, async (ctx, next) => {
    ctx.params.oauth_id.should.be.a.String().and.not.empty();

    let app = await OauthAPP.findById(ctx.params.oauth_id);
    auth.assert(app, '应用不存在');
    await app.remove();

    ctx.state.flash.success = "删除OAUTH应用成功";
    await ctx.redirect('back');
});

// 用户管理
router.get('/admin/users', auth.adminRequired, async (ctx, next) => {
    await ctx.render('admin_users', {layout: 'admin_layout'});
});
router.get('/admin/users_list', auth.adminRequired, async (ctx, next) => {
    let user_lines = await chelper.fetchUsersInfo();
    await ctx.render('admin_users_list', {layout: 'admin_layout',
        user_lines: user_lines
    });
});
router.get('/admin/users_list_download', auth.adminRequired, async (ctx, next) => {
    ctx.set("Content-Disposition", "attachment; filename=" + qs.escape("Code+用户列表") + ".csv" );
    let lines = await chelper.fetchUsersInfo();
    let content = lines.map(x => {return x.join(',')}).join('\n') + '\n';
    if (ctx.request.query.encoding) {
        content = iconv.encode(content, ctx.request.query.encoding);
    }
    ctx.body = content;
});

router.get('/admin/control', auth.adminRequired, async (ctx, next) => {
    let feedbacks = await Feedback.find({}).sort('-_id').limit(5);
    let logins = await NormalLogin.find({userID: feedbacks.filter(x => x.userID != null).map(x => x.userID)});
    tools.bindFindByXX(logins, 'userID');
    await ctx.render('admin_control', {layout: 'admin_layout', feedbacks: feedbacks, logins: logins});
});
// su
router.post('/admin/su', auth.adminRequired, async (ctx, next) => {
    ctx.request.body.username.should.be.a.String().and.not.empty();
    let login = await NormalLogin.findOne({username: ctx.request.body.username});
    auth.assert(login, '用户不存在');
    await auth.login(ctx, login.userID);
    await ctx.redirect('/');
});

// 邮件
router.get('/admin/email_templates', auth.adminRequired, async (ctx, next) => {
    let templates = await EMailTemplate.find({}).sort('-_id');
    await ctx.render('admin_email_templates', { layout: 'admin_layout', templates: templates });
});
router.get('/admin/email_templates/:template_id/preview', auth.adminRequired, async (ctx, next) => {
    let template = await EMailTemplate.findById(ctx.params.template_id);
    auth.assert(template, '模板不存在');
    ctx.body = await email.renderTemplate(template.content, _.assign(template.default_env, await email.selectVariable(ctx.state.user)));
});
router.post('/admin/email_templates', auth.adminRequired, body, async (ctx, next) => {
    let title = ctx.request.fields.title;
    let template_file = ctx.request.fields.content ? ctx.request.fields.content[0] : null;
    let default_env = ctx.request.fields.default_env;
    auth.assert(title, '无标题');
    auth.assert(template_file && template_file.path && (await mzfs.stat(template_file.path)).size > 0, '无模板');
    
    let content = await mzfs.readFile(template_file.path, 'utf-8');
    default_env = default_env ? JSON.parse(default_env) : {};
    
    await EMailTemplate.create({title, content, default_env});

    ctx.state.flash.success = '创建成功';
    await ctx.redirect('back');
});
router.post('/admin/email_templates/:template_id', auth.adminRequired, body, async (ctx, next) => {
    let template = await EMailTemplate.findById(ctx.params.template_id);
    auth.assert(template, '模板不存在');

    let title = ctx.request.fields.title;
    let template_file = ctx.request.fields.content ? ctx.request.fields.content[0] : null;
    let default_env = ctx.request.fields.default_env;

    if (title) template.title = title;
    if (template_file && template_file.path && (await mzfs.stat(template_file.path)).size > 0)
        template.content = await mzfs.readFile(template_file.path, 'utf-8');
    if (default_env) template.default_env = JSON.parse(default_env);

    await template.save();

    ctx.state.flash.success = '修改成功';
    await ctx.redirect('back');
});
router.get('/admin/email_templates/:template_id/download', auth.adminRequired, async (ctx, next) => {
    let template = await EMailTemplate.findById(ctx.params.template_id);
    auth.assert(template, '模板不存在');

    ctx.set('Content-Disposition', 'attachment; filename="template.html"');
    ctx.body = template.content;
});
router.get('/admin/email_send_list', auth.adminRequired, async (ctx, next) => {
    let current_page = Number(ctx.query.page) || 1;
    let page_size = 20;
    let total_page = Math.floor((await EMailToSend.find({}).count() + page_size - 1) / page_size);
    let unfinished_count = await EMailToSend.find({has_sent: false}).count();
    let templates = await EMailTemplate.find({});
    let emails = await EMailToSend.find({}).sort('-_id').skip(current_page*page_size - page_size).limit(page_size);
    tools.bindFindByXX(templates, '_id');

    if (ctx.query.filter && _.trim(ctx.query.filter).length) {
        emails = await EMailToSend.find({}).sort('-_id').$where(ctx.query.filter);
    }

    await ctx.render('admin_email_send_list', {
        layout: 'admin_layout',
        current_page: current_page, page_size: page_size, total_page: total_page, unfinished_count: unfinished_count,
        templates: templates, emails: emails,
        filter: ctx.query.filter
    });
});
router.get('/admin/email_send_list/:task_id/preview', auth.adminRequired, async (ctx, next) => {
    let task = await EMailToSend.findById(ctx.params.task_id);
    auth.assert(task, '发送任务不存在');

    ctx.body = await email.renderEmailTask(task);
});
router.get('/admin/email_send_list/:task_id/resend', auth.adminRequired, async (ctx, next) => {
    let task = await EMailToSend.findById(ctx.params.task_id);
    auth.assert(task, '发送任务不存在');

    task.has_sent = false;
    await task.save();

    ctx.state.flash.success = '重新发送';
    if(ctx.query.xhr) ctx.body = 'success';
    else await ctx.redirect('back');
});
router.get('/admin/email_send_list/:task_id/sent', auth.adminRequired, async (ctx, next) => {
    let task = await EMailToSend.findById(ctx.params.task_id);
    auth.assert(task, '发送任务不存在');

    task.has_sent = true;
    await task.save();

    ctx.state.flash.success = '取消发送';
    if(ctx.query.xhr) ctx.body = 'success';
    else await ctx.redirect('back');
});
router.get('/admin/email_create', auth.adminRequired, async (ctx, next) => {
    let templates = await EMailTemplate.find({}).sort('-_id');
    let emails = (await User.find({email: {$exists: true}}).select('email')).map(x => x.email);
    await ctx.render('admin_email_create', {layout: 'admin_layout', templates: templates, emails: emails});
});
router.post('/admin/email_create', auth.adminRequired, async (ctx, next) => {
    let template = await EMailTemplate.findById(ctx.request.body.templateID);
    auth.assert(ctx.request.body.templateID && template, '找不到模板');
    let subject = ctx.request.body.subject;
    auth.assert(subject, '需要主题');
    auth.assert(ctx.request.body.addresses, '需要邮件地址');
    let priority = ctx.request.body.priority || 0;
    let addresses = ctx.request.body.addresses.split('\n').map(x => _.trim(x)).filter(x => x.length>0);

    for(let addr of addresses) {
        await EMailToSend.create({
            templateID: template._id,
            to: addr,
            subject: subject,
            priority: priority
        });
    }

    ctx.state.flash.success = '创建成功';
    await ctx.redirect('back');
});
router.get('/admin/email_blacklist', auth.adminRequired, async (ctx, next) => {
    let blacklist = await EMailBlacklist.find({});
    await ctx.render('admin_email_blacklist', { layout: 'admin_layout', blacklist: blacklist });
});

// 反馈
router.get('/admin/feedbacks', auth.adminRequired, async (ctx, next) => {
    let current_page = Number(ctx.query.page) || 1;
    let page_size = 20;
    let total_page = Math.floor((await Feedback.find({}).count() + page_size - 1) / page_size);
    let feedbacks = await Feedback.find({}).sort('-_id').skip(current_page*page_size-page_size).limit(page_size);
    let logins = await NormalLogin.find({userID: feedbacks.filter(x => x.userID != null).map(x => x.userID)});
    tools.bindFindByXX(logins, 'userID');

    await ctx.render('admin_feedbacks', {
        layout: 'admin_layout',
        current_page: current_page, page_size: page_size, total_page: total_page,
        feedbacks: feedbacks, logins: logins
    });
});
