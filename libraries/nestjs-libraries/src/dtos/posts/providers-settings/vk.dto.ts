import { IsBoolean, IsIn, IsOptional } from 'class-validator';
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
}
