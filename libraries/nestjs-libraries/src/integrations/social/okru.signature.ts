import { createHash } from 'crypto';

const md5 = (value: string) =>
  createHash('md5').update(value, 'utf8').digest('hex').toLowerCase();

/**
 * Секрет сессии для методов, вызываемых от имени пользователя.
 * Документация: session_secret_key = md5(access_token + application_secret_key).
 */
export const okruSessionSecret = (accessToken: string, appSecret: string) =>
  md5(accessToken + appSecret);

/**
 * Подпись запроса к API Одноклассников.
 *
 * Алгоритм из документации:
 *   1. убрать из набора параметров access_token / session_key;
 *   2. отсортировать оставшиеся лексикографически по ключу;
 *   3. склеить в строку вида key=value без разделителей;
 *   4. sig = md5(строка + session_secret_key) в нижнем регистре.
 *
 * Подписываются СЫРЫЕ значения. URL-кодирование применяется только при отправке,
 * иначе подпись не сойдётся — это самая частая причина ошибки PARAM_SIGNATURE.
 */
export const okruSignature = (
  params: Record<string, string | number | boolean>,
  sessionSecretKey: string
) => {
  const payload = Object.keys(params)
    .filter((key) => key !== 'access_token' && key !== 'session_key')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('');

  return md5(payload + sessionSecretKey);
};
