'use client';

import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import { FC, useEffect } from 'react';
import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';
import { Select } from '@gitroom/react/form/select';
import { Checkbox } from '@gitroom/react/form/checkbox';
import { useWatch } from 'react-hook-form';
import { VkDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/vk.dto';

const VkSettings: FC = () => {
  const form = useSettings();
  const postType = useWatch({ control: form.control, name: 'post_type' });

  // по умолчанию — обычная запись на стене
  useEffect(() => {
    if (!postType) {
      form.setValue('post_type', 'post');
    }
  }, [postType]);

  return (
    <div className="flex flex-col gap-[16px]">
      <Select label="Тип публикации" {...form.register('post_type')}>
        <option value="post">Запись на стене (текст, фото, видео)</option>
        <option value="clip">Клип (одно вертикальное видео)</option>
      </Select>

      {postType === 'clip' && (
        <div className="text-[12px] text-customColor18">
          Клип — ровно одно видео mp4. VK показывает вертикальные короткие видео
          в разделе «Клипы»; отдельного метода публикации клипов в API нет.
        </div>
      )}

      <Checkbox
        label="Отключить комментарии"
        {...form.register('close_comments')}
      />
      <Checkbox
        label="Подпись автора (только для сообществ)"
        {...form.register('signed')}
      />
    </div>
  );
};

export default withProvider({
  postComment: PostComment.POST,
  minimumCharacters: [],
  SettingsComponent: VkSettings,
  CustomPreviewComponent: undefined,
  dto: VkDto,
  maximumCharacters: 16000,
});
