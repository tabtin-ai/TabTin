/**
 * Specification 模式基础设施
 *
 * 适配 TabTin 的字段体系。
 * 核心思路：一个 Spec 可以同时用于：
 * 1. 内存判定（isSatisfiedBy）
 * 2. 接受 Visitor 转为 SQL / Django Q
 */

export interface ISpecVisitor<T = unknown> {
  visitAnd(spec: AndSpec<T>): void
  visitOr(spec: OrSpec<T>): void
  visitNot(spec: NotSpec<T>): void
}

export interface ISpecification<T = unknown> {
  isSatisfiedBy(candidate: T): boolean
  accept(visitor: ISpecVisitor<T>): void

  and(other: ISpecification<T>): ISpecification<T>
  or(other: ISpecification<T>): ISpecification<T>
  not(): ISpecification<T>
}

export abstract class AbstractSpec<T = unknown> implements ISpecification<T> {
  abstract isSatisfiedBy(candidate: T): boolean
  abstract accept(visitor: ISpecVisitor<T>): void

  and(other: ISpecification<T>): ISpecification<T> {
    return new AndSpec(this, other)
  }

  or(other: ISpecification<T>): ISpecification<T> {
    return new OrSpec(this, other)
  }

  not(): ISpecification<T> {
    return new NotSpec(this)
  }
}

export class AndSpec<T = unknown> extends AbstractSpec<T> {
  constructor(
    public readonly left: ISpecification<T>,
    public readonly right: ISpecification<T>,
  ) {
    super()
  }

  isSatisfiedBy(candidate: T): boolean {
    return this.left.isSatisfiedBy(candidate) && this.right.isSatisfiedBy(candidate)
  }

  accept(visitor: ISpecVisitor<T>): void {
    visitor.visitAnd(this)
  }
}

export class OrSpec<T = unknown> extends AbstractSpec<T> {
  constructor(
    public readonly left: ISpecification<T>,
    public readonly right: ISpecification<T>,
  ) {
    super()
  }

  isSatisfiedBy(candidate: T): boolean {
    return this.left.isSatisfiedBy(candidate) || this.right.isSatisfiedBy(candidate)
  }

  accept(visitor: ISpecVisitor<T>): void {
    visitor.visitOr(this)
  }
}

export class NotSpec<T = unknown> extends AbstractSpec<T> {
  constructor(public readonly inner: ISpecification<T>) {
    super()
  }

  isSatisfiedBy(candidate: T): boolean {
    return !this.inner.isSatisfiedBy(candidate)
  }

  accept(visitor: ISpecVisitor<T>): void {
    visitor.visitNot(this)
  }
}

/** 永远为真的 Spec */
export class TrueSpec<T = unknown> extends AbstractSpec<T> {
  isSatisfiedBy(): boolean { return true }
  accept(): void { /* noop */ }
}

/** 永远为假的 Spec */
export class FalseSpec<T = unknown> extends AbstractSpec<T> {
  isSatisfiedBy(): boolean { return false }
  accept(): void { /* noop */ }
}
