
let _ = require('lodash');
let utils = require('utility');
let { User, NormalLogin, GithubLogin } = require('../models');
require('should');

const ERR_CODE = 978;

const FRIENDLY_CHARSET = "123456789qwertyuplkjhgfdsazxcvbnmQWERTYUPKJHGFDSAZXCVBNM";

/// 用户中间件
/// 检查用户是否已经登录，查询数据库并放在ctx.state.user变量上
let userM = exports.userM = async function (ctx, next) {
	let user_id = ctx.session.user_id;
    ctx.state.user = null;
    
	if (user_id) {
        ctx.state.user = await User.findById(user_id);
        ctx.state.normal_login = await NormalLogin.findOne({userID: user_id});
	}

	try {
		await next();
	} catch(e) {
		if (e.status === ERR_CODE) {
            ctx.state.flash.error = e._msg;
            await ctx.redirect('back');
		} else {
            ctx.state.flash.error = e.message;
            await ctx.redirect('back');
            console.error(e);
        }
	}
}

let assert = exports.assert = function (condition, msg) {
    msg.should.be.a.String();

	if (!condition) {
		let err = new Error();
        err.status = ERR_CODE;
        err._msg = msg;
		throw err;
	}
}

// 正常登录
exports.normal_login = async function (ctx, username, password) {
    let login = await NormalLogin.findOne({username: username});
    assert(login, '用户不存在');
    assert(login.password == utils.sha256(password + login.random_salt), '密码错误');

    ctx.session.user_id = login.userID;
	ctx.state.user = await User.findById(login.userID);
}

// Github登录
exports.github_login = async function (ctx, info) {
    let login = await GithubLogin.findOne({id: info.id});
    if (!login) {
        login = new GithubLogin({id: info.id});
        let user = new User({nickname: info.name});
        login.userID = user._id;
        await login.save();
        await user.save();
    }

    _.assign(login, info);
    await login.save();
    
    ctx.session.user_id = login.userID;
	ctx.state.user = await User.findById(login.userID);
}

exports.register = async function (ctx, username, password) {
    assert(!await NormalLogin.findOne({username: username}), '用户名已存在');
    
    let login = new NormalLogin();
    login.username = username;
    login.random_salt = utils.randomString(32, '1234567890');
    login.password = utils.sha256(password + login.random_salt);
    login.oj_username = "code+_" + username;
    login.oj_password = utils.randomString(10, FRIENDLY_CHARSET);

    let user = new User();
    login.userID = user._id;
    user.nickname = username;

    await login.save();
    await user.save();

    ctx.session.user_id = user._id;
	ctx.state.user = user;
}

exports.createAccount = async function (ctx, username, password) {
    assert(!await NormalLogin.findOne({username: username}), '用户名已存在');
    
    let login = new NormalLogin();
    login.username = username;
    login.random_salt = utils.randomString(32, '1234567890');
    login.password = utils.sha256(password + login.random_salt);
    login.oj_username = "code+_" + username;
    login.oj_password = utils.randomString(10, FRIENDLY_CHARSET);

    login.userID = ctx.state.user;

    await login.save();
}

// 登录的情况下修改密码
exports.modifyPassword = async function (ctx, password) {
    let login = ctx.state.normal_login;
    login.password = utils.sha256(password + login.random_salt);

    await login.save();
}

// 忘记密码的情况下重置密码
exports.resetPassword = async function (ctx, user, password) {
    let login = await NormalLogin.findOne({userID: user._id});
    assert(login); // 要求有帐号才能找回密码
    // if (!login) {
    //     login = new NormalLogin();
    //     login.userID = user._id;
    //     login.username = user.email;
    //     login.random_salt = utils.randomString(32, '1234567890');
    // }
    login.password = utils.sha256(password + login.random_salt);

    ctx.session.user_id = login.userID;
	ctx.state.user = user;

    await login.save();
}

// 登出
exports.logout = async function (ctx) {
	ctx.session.user_id = null;
}

/// 需用户登录
exports.loginRequired = async function (ctx, next) {
    assert(ctx.state.user, '尚未登录');
	await next();
}
