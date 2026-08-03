/**
 * Feishu message/card practical rendering limit.
 * 飞书实际限制约 30KB，但需要考虑 JSON 包装后的总大小。
 * 保守设为 20KB，确保不会因为内容过大触发格式错误。
 */
export const FEISHU_MESSAGE_LIMIT = 20000;
