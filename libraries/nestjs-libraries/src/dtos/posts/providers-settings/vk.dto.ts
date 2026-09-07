import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { JSONSchema } from 'class-validator-jsonschema';

export class VkDto {
  // post — обычная запись на стене (текст, фото, карусель фото, видео),
  // clip — вертикальный клип: ровно одно видео, публикуется в VK Клипы
  @IsIn(['post', 'clip'])
  @IsOptional()
  @JSONSchema({
    description: 'Wall post ("post") or a single vertical video clip ("clip")',
  })
  post_type?: 'post' | 'clip';

  @IsBoolean()
  @IsOptional()
  @JSONSchema({ description: 'Disable comments for this post' })
  close_comments?: boolean;

  @IsBoolean()
  @IsOptional()
  @JSONSchema({ description: 'Add the author signature to a community post' })
  signed?: boolean;

  // Вложения, уже загруженные в VK заранее: "photo-<owner>_<id>,video-<owner>_<id>".
  // Если заданы — медиа поста в момент публикации не грузится, крепятся они.
  @IsString()
  @IsOptional()
  @JSONSchema({
    description:
      'Pre-uploaded VK attachments, comma separated (photo-<owner>_<id>, video-<owner>_<id>); when set, post media is not uploaded again',
  })
  attachments?: string;
}
