import {
  AuthTokenDetails,
  FetchPageInformationResult,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import dayjs from 'dayjs';
import { SocialAbstract } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { createHash, randomBytes } from 'crypto';
import FormDataNew from 'form-data';
import mime from 'mime-types';
import { Integration } from '@prisma/client';
import { hasExtension } from '@gitroom/helpers/utils/has.extension';

export class VkProvider extends SocialAbstract implements SocialProvider {
  override maxConcurrentJob = 2; // VK has moderate API limits
  identifier = 'vk';
  name = 'VK';
  // После OAuth пользователь выбирает, куда постить: личная страница или сообщество.
  isBetweenSteps = true;
  scopes = [
    'vkid.personal_info',
    'email',
    'wall',
    'status',
    'docs',
    'photos',
    'video',
    'groups',
  ];

  editor = 'normal' as const;
  maxLength() {
    return 2048;
  }

  async refreshToken(refresh: string): Promise<AuthTokenDetails> {
    const [oldRefreshToken, device_id] = refresh.split('&&&&');
    const formData = new FormData();
    formData.append('grant_type', 'refresh_token');
    formData.append('refresh_token', oldRefreshToken);
    formData.append('client_id', process.env.VK_ID!);
    formData.append('device_id', device_id);
    formData.append('state', makeId(32));
    formData.append('scope', this.scopes.join(' '));

    const { access_token, refresh_token, expires_in } = await (
      await this.fetch('https://id.vk.com/oauth2/auth', {
        method: 'POST',
        body: formData,
      })
    ).json();

    const newFormData = new FormData();
    newFormData.append('client_id', process.env.VK_ID!);
    newFormData.append('access_token', access_token);

    const {
      user: { user_id, first_name, last_name, avatar },
    } = await (
      await this.fetch('https://id.vk.com/oauth2/user_info', {
        method: 'POST',
        body: newFormData,
      })
    ).json();

    return {
      // префикс "u", чтобы pending-запись не совпала по internalId с уже
      // подключённым каналом (личным "u<id>"/легаси "<id>" или "-<gid>")
      id: `u${user_id}`,
      name: first_name + ' ' + last_name,
      accessToken: access_token,
      refreshToken: refresh_token + '&&&&' + device_id,
      expiresIn: dayjs().add(expires_in, 'seconds').unix() - dayjs().unix(),
      picture: avatar || '',
      username: first_name.toLowerCase(),
    };
  }

  async generateAuthUrl() {
    const state = makeId(32);
    const codeVerifier = randomBytes(64).toString('base64url');
    const challenge = Buffer.from(
      createHash('sha256').update(codeVerifier).digest()
    )
      .toString('base64')
      .replace(/=*$/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    return {
      url:
        'https://id.vk.com/authorize' +
        `?response_type=code` +
        `&client_id=${process.env.VK_ID}` +
        `&code_challenge_method=S256` +
        `&code_challenge=${challenge}` +
        `&redirect_uri=${encodeURIComponent(
          `${
            process?.env.FRONTEND_URL?.indexOf('https') == -1
              ? `https://redirectmeto.com/${process?.env.FRONTEND_URL}`
              : `${process?.env.FRONTEND_URL}`
          }/integrations/social/vk`
        )}` +
        `&state=${state}` +
        `&scope=${encodeURIComponent(this.scopes.join(' '))}`,
      codeVerifier,
      state,
    };
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    const [code, device_id] = params.code.split('&&&&');

    const formData = new FormData();
    formData.append('client_id', process.env.VK_ID!);
    formData.append('grant_type', 'authorization_code');
    formData.append('code_verifier', params.codeVerifier);
    formData.append('device_id', device_id);
    formData.append('code', code);
    formData.append(
      'redirect_uri',
      `${
        process?.env.FRONTEND_URL?.indexOf('https') == -1
          ? `https://redirectmeto.com/${process?.env.FRONTEND_URL}`
          : `${process?.env.FRONTEND_URL}`
      }/integrations/social/vk`
    );

    const { access_token, scope, refresh_token, expires_in } = await (
      await this.fetch('https://id.vk.com/oauth2/auth', {
        method: 'POST',
        body: formData,
      })
    ).json();

    const newFormData = new FormData();
    newFormData.append('client_id', process.env.VK_ID!);
    newFormData.append('access_token', access_token);

    const {
      user: { user_id, first_name, last_name, avatar },
    } = await (
      await this.fetch('https://id.vk.com/oauth2/user_info', {
        method: 'POST',
        body: newFormData,
      })
    ).json();

    return {
      // префикс "u", чтобы pending-запись не совпала по internalId с уже
      // подключённым каналом (личным "u<id>"/легаси "<id>" или "-<gid>")
      id: `u${user_id}`,
      name: first_name + ' ' + last_name,
      accessToken: access_token,
      refreshToken: refresh_token + '&&&&' + device_id,
      expiresIn: dayjs().add(expires_in, 'seconds').unix() - dayjs().unix(),
      picture: avatar || '',
      username: first_name.toLowerCase(),
    };
  }

  // internalId интеграции: "u<id>" или легаси "<id>" — личная страница, "-<gid>" — сообщество
  private groupId(userId: string): string | null {
    return String(userId).startsWith('-') ? String(userId).slice(1) : null;
  }

  // числовой owner_id для VK API (срезает префикс "u" личной страницы)
  private ownerId(userId: string): string {
    return String(userId).startsWith('u')
      ? String(userId).slice(1)
      : String(userId);
  }

  async pages(accessToken: string) {
    const { response: users } = await (
      await this.fetch(
        `https://api.vk.com/method/users.get?fields=photo_200&v=5.251&access_token=${accessToken}`
      )
    ).json();
    const [me] = users || [];

    const { response: groups } = await (
      await this.fetch(
        `https://api.vk.com/method/groups.get?extended=1&filter=admin,editor&fields=photo_200&v=5.251&access_token=${accessToken}`
      )
    ).json();

    return [
      ...(me
        ? [
            {
              id: `u${me.id}`,
              name: `${me.first_name} ${me.last_name} — личная страница`,
              picture: { data: { url: me.photo_200 || '' } },
            },
          ]
        : []),
      ...(groups?.items || []).map((group: any) => ({
        id: `-${group.id}`,
        name: group.name,
        picture: { data: { url: group.photo_200 || '' } },
      })),
    ];
  }

  async fetchPageInformation(
    accessToken: string,
    data: { page: string }
  ): Promise<FetchPageInformationResult> {
    const id = String(data.page);
    const gid = this.groupId(id);

    if (gid) {
      const { response } = await (
        await this.fetch(
          `https://api.vk.com/method/groups.getById?group_id=${gid}&fields=photo_200&v=5.251&access_token=${accessToken}`
        )
      ).json();
      // v5.251 возвращает { groups: [...] }, старые версии — массив
      const group = response?.groups?.[0] || response?.[0];
      return {
        id,
        name: group?.name || `Сообщество ${gid}`,
        access_token: accessToken,
        picture: group?.photo_200 || '',
        username: group?.screen_name || '',
      };
    }

    const { response } = await (
      await this.fetch(
        `https://api.vk.com/method/users.get?user_ids=${this.ownerId(
          id
        )}&fields=photo_200,screen_name&v=5.251&access_token=${accessToken}`
      )
    ).json();
    const [user] = response || [];
    return {
      id,
      name: user ? `${user.first_name} ${user.last_name}` : id,
      access_token: accessToken,
      picture: user?.photo_200 || '',
      username: user?.screen_name || '',
    };
  }

  async reConnect(
    id: string,
    requiredId: string,
    accessToken: string
  ): Promise<Omit<AuthTokenDetails, 'refreshToken' | 'expiresIn'>> {
    const information = await this.fetchPageInformation(accessToken, {
      page: requiredId,
    });
    return {
      id: information.id,
      name: information.name,
      accessToken: information.access_token,
      picture: information.picture,
      username: information.username,
    };
  }

  private async uploadMedia(
    userId: string,
    accessToken: string,
    post: PostDetails
  ): Promise<{ id: string; type: string; owner: string }[]> {
    const gid = this.groupId(userId);
    const owner = this.ownerId(userId);
    return await Promise.all(
      (post?.media || []).map(async (media) => {
        const all = await (
          await this.fetch(
            hasExtension(media.path, 'mp4')
              ? `https://api.vk.com/method/video.save?access_token=${accessToken}&v=5.251${
                  gid ? `&group_id=${gid}` : ''
                }`
              : `https://api.vk.com/method/photos.getWallUploadServer?access_token=${accessToken}&v=5.251${
                  gid ? `&group_id=${gid}` : `&owner_id=${owner}`
                }`
          )
        ).json();

        const { data } = await this.getSsrfSafeAxios().get(media.path!, {
          responseType: 'stream',
        });

        const slash = media.path.split('/').at(-1);

        const formData = new FormDataNew();
        formData.append('photo', data, {
          filename: slash,
          contentType: mime.lookup(slash!) || '',
        });
        const value = (
          await this.getSsrfSafeAxios().post(
            all.response.upload_url,
            formData,
            {
              headers: {
                ...formData.getHeaders(),
              },
            }
          )
        ).data;

        if (hasExtension(media.path, 'mp4')) {
          return {
            id: all.response.video_id,
            type: 'video',
            owner: String(all.response.owner_id ?? owner),
          };
        }

        const formSend = new FormData();
        formSend.append('photo', value.photo);
        formSend.append('server', value.server);
        formSend.append('hash', value.hash);

        const { id, owner_id } = (
          await (
            await fetch(
              `https://api.vk.com/method/photos.saveWallPhoto?access_token=${accessToken}&v=5.251${
                gid ? `&group_id=${gid}` : ''
              }`,
              {
                method: 'POST',
                body: formSend,
              }
            )
          ).json()
        ).response[0];

        return {
          id,
          type: 'photo',
          owner: String(owner_id ?? owner),
        };
      })
    );
  }

  async post(
    userId: string,
    accessToken: string,
    postDetails: PostDetails[]
  ): Promise<PostResponse[]> {
    const [firstPost] = postDetails;

    // Upload media for the first post
    const mediaList = await this.uploadMedia(userId, accessToken, firstPost);

    const owner = this.ownerId(userId);
    const body = new FormData();
    body.append('message', firstPost.message);
    body.append('owner_id', owner);
    if (this.groupId(userId)) {
      body.append('from_group', '1');
    }

    if (mediaList.length) {
      body.append(
        'attachments',
        mediaList.map((p) => `${p.type}${p.owner}_${p.id}`).join(',')
      );
    }

    const { response } = await (
      await this.fetch(
        `https://api.vk.com/method/wall.post?v=5.251&access_token=${accessToken}&client_id=${process.env.VK_ID}`,
        {
          method: 'POST',
          body,
        }
      )
    ).json();

    return [
      {
        id: firstPost.id,
        postId: String(response?.post_id),
        releaseURL: `https://vk.com/wall${owner}_${response?.post_id}`,
        status: 'completed',
      },
    ];
  }

  async comment(
    userId: string,
    postId: string,
    lastCommentId: string | undefined,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [commentPost] = postDetails;

    // Upload media for the comment
    const mediaList = await this.uploadMedia(userId, accessToken, commentPost);

    const owner = this.ownerId(userId);
    const gid = this.groupId(userId);
    const body = new FormData();
    body.append('message', commentPost.message);
    body.append('post_id', postId);
    body.append('owner_id', owner);
    if (gid) {
      // в wall.createComment from_group — это id сообщества, а не флаг
      body.append('from_group', gid);
    }

    if (mediaList.length) {
      body.append(
        'attachments',
        mediaList.map((p) => `${p.type}${p.owner}_${p.id}`).join(',')
      );
    }

    const { response } = await (
      await this.fetch(
        `https://api.vk.com/method/wall.createComment?v=5.251&access_token=${accessToken}&client_id=${process.env.VK_ID}`,
        {
          method: 'POST',
          body,
        }
      )
    ).json();

    return [
      {
        id: commentPost.id,
        postId: String(response?.comment_id),
        releaseURL: `https://vk.com/wall${owner}_${postId}`,
        status: 'completed',
      },
    ];
  }
}
