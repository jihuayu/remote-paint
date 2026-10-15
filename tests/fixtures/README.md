# Fixture assets

`NotoSansSC-subset.ttf` is a Google Fonts text subset of Noto Sans SC, weight 400.
Source: `https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400&text=...`.
The `text` parameter contains ASCII U+0020–U+007E and these characters:

```text
·→远程绘制中文测试服务器执行网页客户端重放文字图片表单静态快照输入确认下一步本地字体资源不传输原始页面
```

The upstream SIL Open Font License is included as `OFL.txt` (from
`https://github.com/notofonts/noto-cjk/blob/main/Sans/LICENSE`). The subset retains
the font's embedded copyright/name metadata. It is a deterministic fixture asset,
not a font subset generator for arbitrary websites.

`sample.png` is generated locally by `capture/fixture.mjs` as a colored gradient.
No runtime CDN or external image/font requests are required.
