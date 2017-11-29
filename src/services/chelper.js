// contest helper

let { STORAGE } = require('../config');
let { User, Contest, ContestSign, NormalLogin } = require('../models');
let path = require('path');
let mzfs = require('mz/fs');

let auth = require('./auth');
let tools = require('./tools');

// 获取默认比赛信息
let fetchDefaultContest = exports.fetchDefaultContest = async function(ctx) {
    let contest = await Contest.findOne({public: true}).sort('-no');
    let contest_sign = null;
    if (ctx.state.user) {
        contest_sign = await ContestSign.findOne({userID: ctx.state.user._id, contestID: contest._id});
    }
    return {contest, contest_sign};
}

// 比赛报名检查
let contestSignCheck = exports.contestSignCheck = async function (contest_id) {
    let contest = await Contest.findById(contest_id);
    auth.assert(contest, '比赛不存在');
    auth.assert(contest.begin_sign_time <= Date.now() && Date.now() <= contest.end_sign_time, '不在报名开放时间内');
    auth.assert(contest.public, '比赛未公开');

    return contest;
}

// 下载比赛快递信息
let fetchContestExpressInfoCSV = exports.fetchContestExpressInfoCSV = async function (contest) {
    let signs = await ContestSign.find({contestID: contest._id, has_award: true});
    let users = await User.find();
    let logins = await NormalLogin.find();
    tools.bindFindByXX(users, '_id');
    tools.bindFindByXX(logins, 'userID');

    let lines = [];
    lines.push(["ID", "姓名", "比赛", "电话", "邮箱", "是否已填", "学校", "收件人姓名", "收件人联系电话", "省", "市", "区", "详细地址"]);
    signs.forEach((s) => {
        let line = [];
        line.push(logins.findByuserID(s.userID).username);
        line.push(users.findBy_id(s.userID).real_name);
        line.push(s.type);
        line.push(users.findBy_id(s.userID).phone_number);
        line.push(users.findBy_id(s.userID).email);
        line.push(s.express_info_filled ? '是' : '否');
        line.push(s.school);
        line.push(s.receiver);
        line.push(s.phone);
        line.push(s.prov);
        line.push(s.city);
        line.push(s.county);
        line.push(s.addr);
        lines.push(line);
    });

    return lines.map((x) => {return x.join(',');}).join('\n');
}

let fetchZIPPath = exports.fetchZIPPath = async function(contest) {
    if (contest.repository_local_name && await mzfs.exists(path.join(STORAGE.REPO, contest.repository_local_name))) {
        let contest_path = path.join(STORAGE.REPO, contest.repository_local_name);
        if (await mzfs.exists(path.join(contest_path, 'download.zip'))) {
            return path.join(contest_path, 'download.zip');
        }
    }
    return null;
}

let fetchProblemInfo = exports.fetchProblemInfo = async function (contest, type, idx) {
    let contest_path = path.join(STORAGE.REPO, contest.repository_local_name);
    let root_dir = path.join(contest_path, type);
    let conf = JSON.parse(await mzfs.readFile(path.join(root_dir, 'conf.json'), 'utf-8'));
    let problem_dir = path.join(root_dir, conf['subdir'][idx]);
    let problem_conf = JSON.parse(await mzfs.readFile(path.join(problem_dir, 'conf.json'), 'utf-8'));
    let problem_name = path.basename(problem_dir);
    let problem_title = problem_conf['title']['zh-cn'];
    let problem_content = await mzfs.readFile(path.join(contest_path, 'statements', 'tuoj', type, problem_name + '.md'), 'utf-8');

    let problem_solution = null;
    for(let file of await mzfs.readdir(problem_dir)) {
        if ((await mzfs.stat(path.join(problem_dir, file))).isFile() && file.toLowerCase().startsWith('solution')) {
            problem_solution = path.join(problem_dir, file);
        }
    }
    let problem_link = null;
    try {
        let links = JSON.parse(await mzfs.readFile(path.join(contest_path, 'links.json'), 'utf-8'));
        problem_link = links[problem_name];
    } catch(e){
    }

    return {
        contest_path: contest_path,
        name: problem_name,
        title: problem_title,
        content: problem_content,
        solution: problem_solution,
        link: problem_link
    };
}

let fetchProblems = exports.fetchProblems = async function(contest, type) {
    let contest_path = path.join(STORAGE.REPO, contest.repository_local_name);
    let root_dir = path.join(contest_path, type);
    let conf = JSON.parse(await mzfs.readFile(path.join(root_dir, 'conf.json'), 'utf-8'));
    let problems = [];
    for(let idx in conf['subdir']) {
        problems.push(await fetchProblemInfo(contest, type, idx));
    }
    return problems;
}