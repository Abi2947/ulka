import fs from 'fs'
import util from 'util'
import path from 'path'
import c from 'ansi-colors'
import matter from 'gray-matter'
import * as ulkaTemplate from '@ulkajs/template-engine'

import { UlkaError } from '../UlkaError'

import type { Ulka } from '../Ulka'
import type { FileInfo } from '../FileInfo'

const writeFile = util.promisify(fs.writeFile)
const mkdir = util.promisify(fs.mkdir)

export class Template {
  public content: string | Buffer = ''
  public link: string = ''
  public buildPath: string = ''
  public dontBuild = false

  public context: { [key: string]: any } = {}

  constructor(
    public ulka: Ulka,
    public fileinfo: FileInfo,
    public configName?: string,
    public configLayout?: Function | string | null,
    public configLink?: Function | string | null
  ) {}

  async compile() {
    return async (_ctx: object = {}) => this.content
  }

  protected async layout(
    content: string | Buffer,
    ctx: object = {}
  ): Promise<string | Buffer> {
    const matter = this.context.matter

    // if matter._layout `false` then return content
    if (matter._layout === false) return content

    // if there is no layout collection or no layout directory then return content
    if (!this.ulka.layout || !this.ulka.configs.layout) return content

    // if matter._layout is not defined && no layout passed from layout content then return content
    if (!matter._layout && !this.configLayout) return content

    // if templateSpecialFrontMatter is true render matter._layout with @ulkajs/template-engine
    // give first priority to matter._layout and then from config
    const base = this.ulka.configs.include
    const _layout = matter._layout
      ? this.ulka.configs.templateSpecialFrontMatter
        ? ulkaTemplate.render(matter._layout, this.context, { base })
        : matter._layout
      : typeof this.configLayout === 'function'
      ? this.configLayout(this)
      : this.configLayout

    // if _layout is not string return content
    // for eg. configLayout function ma return anything execept function
    if (typeof _layout !== 'string') return content

    // absolute layout path to _layout
    const lpath = path.join(this.ulka.configs.layout, _layout)

    try {
      // find the layout in layout collection
      // if not found return content
      const tpl = this.ulka.layout.contents.find(
        (v: Template) => v.fileinfo.filepath === lpath
      )
      if (!tpl) return content

      // if layout is found in layoutcache then renderFunc will be that cache
      // else compile the layout and cache the renderFunc
      let renderFunc = this.ulka.layoutFuncCache[lpath]
      if (!renderFunc) {
        renderFunc = await tpl.compile()
        this.ulka.layoutFuncCache[lpath] = renderFunc
      }

      // current template context is inside _ cause layout will have its own context
      // _ in layout will be reference to current template context
      const _ = { ...this.context, content, ...ctx }
      const contentWithLayout = await renderFunc({ _ })

      // recurse the current function incase layout has another layout
      return tpl.layout(contentWithLayout, { _ })
    } catch (e) {
      const cwd = this.ulka.cwd
      const rlpath = path.relative(cwd, lpath)
      const rfpath = path.relative(cwd, this.fileinfo.filepath)

      throw new UlkaError(
        e.message,
        `Error occured while rendering layout ${rlpath} for ${rfpath}`
      )
    }
  }

  public async render(ctx?: object) {
    try {
      await mkdir(path.parse(this.buildPath).dir, { recursive: true })

      const renderFunction = await this.compile()
      const content = await renderFunction(ctx)
      this.content = await this.layout(content)
    } catch (e) {
      const cwd = this.ulka.cwd
      const rfpath = path.relative(cwd, this.fileinfo.filepath)

      if (e.custom) throw e

      throw new UlkaError(
        e.message,
        `Error occured while rendering file ${rfpath}`
      )
    }
  }

  public async write(content: string | Buffer = this.content) {
    try {
      await writeFile(this.buildPath, content)
    } catch (e) {
      const rbpath = path.relative(this.ulka.cwd, this.buildPath)
      const rfpath = path.relative(this.ulka.cwd, this.fileinfo.filepath)

      throw new UlkaError(
        e.message,
        `Error occured while writing file ${rfpath} to ${rbpath}`
      )
    }

    return this
  }

  createCtx(ctx: object = {}) {
    const matter = this.context.matter || {}
    let { link, buildPath } = this.getBuildPath()

    this.context = {
      link,
      matter,
      buildPath,
      cwd: this.ulka.cwd,
      task: this.ulka.task,
      content: this.content,
      name: this.configName,
      fileinfo: this.fileinfo,
      configs: this.ulka.configs,
      _collections: this.ulka.collections,
      collections: this.ulka.collectionContents,
      ...ctx,
    }

    // if matter has _link prop and templateSpecialFrontMatter is turned on
    // render matter._link with @ulkajs/template-engine
    if (matter._link) {
      link = this.ulka.configs.templateSpecialFrontMatter
        ? ulkaTemplate.render(matter._link, this.context, {
            base: this.ulka.configs.include,
          })
        : matter._link

      buildPath = path.join(...link.split('/'))
      if (link.endsWith('/index.html')) link = link.replace('/index.html', '/')
    } else if (this.configLink) {
      link =
        typeof this.configLink === 'function'
          ? this.configLink(this)
          : this.configLink

      buildPath = path.join(...link.split('/'))
      if (link.endsWith('/index.html')) link = link.replace('/index.html', '/')
    }

    buildPath = path.join(this.ulka.configs.output, buildPath)

    link = !link.startsWith('/') ? '/' + link : link

    if (link !== '/' && !link.endsWith('/')) link += '/'

    this.link = link
    this.buildPath = buildPath
    this.context.link = link
    this.context.buildPath = buildPath

    return this
  }

  readMatter() {
    if (!this.hasMatter) {
      if (this.contentShouldBeString) this.content = this.fileinfo.str
      else this.content = this.fileinfo.buffer!

      this.context.matter = {}
      return this
    }

    const { data, content } = matter(this.fileinfo.str)

    this.content = content
    this.context.matter = data

    return this
  }

  getBuildPath(ext = this.buildExt) {
    let rel = path.relative(
      this.ulka.configs.input,
      this.fileinfo.parsedpath.dir
    )

    let name = this.fileinfo.parsedpath.name

    // if ext = html and name != index.html then create folder with name and change name to index
    // for eg:
    // if file is about.html create a folder named about
    // and a file inside about as index.html
    // about.html => about/index.html
    if (ext === '.html') {
      if (name !== 'index') {
        rel = path.join(rel, name)
        name = 'index'
      }
    }

    const buildPath = path.join(rel, name + ext)

    const link = rel.split(path.sep).join('/')

    return { link, buildPath }
  }

  log() {
    const output = path
      .relative(this.ulka.cwd, this.buildPath)
      .split(path.sep)
      .join('/')

    console.log(c.blue.bold('>'), c.dim(output))
  }

  get hasMatter() {
    return true
  }

  get buildExt() {
    return this.fileinfo.parsedpath.ext
  }

  get contentShouldBeString() {
    return this.hasMatter
  }
}
