/**
 * platforms/damai/account-manager.mjs
 * =====================================================================
 * 大麦观演人与收货地址管理模块
 * 提供：
 *   1. GB 11643-1999 中国第二代居民身份证 18 位 Modulo 11-2 严格校验算法
 *   2. 中国大陆 11 位手机号严格正则校验
 *   3. 观演人与收货地址本地配置文件 (account.profile.json) 读写与同步
 * =====================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PROFILE_FILE = path.join(ROOT, 'data', 'grab', 'account.profile.json');

/**
 * GB 11643-1999 中华人民共和国公民身份号码校验
 * @param {string} idCard 18位身份证号
 * @returns {{ valid: boolean, message: string, birthDate?: string, gender?: string }}
 */
export function validateIdCard(idCard) {
  if (!idCard || typeof idCard !== 'string') {
    return { valid: false, message: '身份证号不能为空' };
  }

  const trimmed = idCard.trim().toUpperCase();

  // 1. 基础格式检查：17位数字 + 1位校验码(0-9或X)
  const regex = /^[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dX]$/;
  if (!regex.test(trimmed)) {
    return { valid: false, message: '身份证号格式不正确（必须为18位，前17位数字，末位数字或X）' };
  }

  // 2. 出生年月日合法性检查
  const year = parseInt(trimmed.substring(6, 10), 10);
  const month = parseInt(trimmed.substring(10, 12), 10);
  const day = parseInt(trimmed.substring(12, 14), 10);
  const dateObj = new Date(year, month - 1, day);

  if (
    dateObj.getFullYear() !== year ||
    dateObj.getMonth() + 1 !== month ||
    dateObj.getDate() !== day ||
    dateObj > new Date() ||
    year < 1900
  ) {
    return { valid: false, message: '身份证出生年月日无效' };
  }

  // 3. ISO 7064:1983.MOD 11-2 校验码计算
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checkCodes = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

  let sum = 0;
  for (let i = 0; i < 17; i++) {
    sum += parseInt(trimmed.charAt(i), 10) * weights[i];
  }

  const expectedCode = checkCodes[sum % 11];
  const actualCode = trimmed.charAt(17);

  if (expectedCode !== actualCode) {
    return {
      valid: false,
      message: `身份证校验位错误：末位应为 ${expectedCode}，实际为 ${actualCode}`,
      expectedCode
    };
  }

  const genderCode = parseInt(trimmed.charAt(16), 10);
  return {
    valid: true,
    message: '身份证合规',
    birthDate: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    gender: genderCode % 2 === 1 ? '男' : '女'
  };
}

/**
 * 中国大陆 11 位手机号校验
 * @param {string} phone
 * @returns {{ valid: boolean, message: string }}
 */
export function validatePhone(phone) {
  if (!phone || typeof phone !== 'string') {
    return { valid: false, message: '手机号不能为空' };
  }

  const trimmed = phone.trim();
  const regex = /^1[3-9]\d{9}$/;
  if (!regex.test(trimmed)) {
    return { valid: false, message: '请输入有效的11位中国大陆手机号码' };
  }

  return { valid: true, message: '手机号合规' };
}

/**
 * 读取本地观演人与地址配置文件
 */
export function loadAccountProfile() {
  if (fs.existsSync(PROFILE_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
      return data;
    } catch (e) {
      console.error('读取 account.profile.json 失败:', e.message);
    }
  }

  return {
    _说明: '大麦实名观演人与收货地址库',
    updatedAt: new Date().toISOString(),
    viewers: [],
    addresses: []
  };
}

/**
 * 写入本地观演人与地址配置文件
 */
export function saveAccountProfile(profile) {
  const dir = path.dirname(PROFILE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  profile.updatedAt = new Date().toISOString();
  fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2), 'utf8');
  return profile;
}
