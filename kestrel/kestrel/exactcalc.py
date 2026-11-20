"""Exact arithmetic with rational numbers (no floating-point error, no model).

Port of the idea behind the gateway's /calc: the language model is bad at
arithmetic, ordinary code is perfect at it.
"""
from __future__ import annotations

import ast
from fractions import Fraction

_MAX_POW = 4096
_MAX_DIGITS = 2000


def _ev(n):
    if isinstance(n, ast.Expression):
        return _ev(n.body)
    if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)) and not isinstance(n.value, bool):
        return Fraction(str(n.value)) if isinstance(n.value, float) else Fraction(n.value)
    if isinstance(n, ast.UnaryOp) and isinstance(n.op, (ast.UAdd, ast.USub)):
        v = _ev(n.operand)
        return v if isinstance(n.op, ast.UAdd) else -v
    if isinstance(n, ast.BinOp):
        a, b = _ev(n.left), _ev(n.right)
        if isinstance(n.op, ast.Add):
            return a + b
        if isinstance(n.op, ast.Sub):
            return a - b
        if isinstance(n.op, ast.Mult):
            return a * b
        if isinstance(n.op, (ast.Div, ast.FloorDiv, ast.Mod)):
            if b == 0:
                raise ValueError("division by zero")
            if isinstance(n.op, ast.Div):
                return a / b
            if isinstance(n.op, ast.FloorDiv):
                return Fraction(a // b)
            return a % b
        if isinstance(n.op, ast.Pow):
            if b.denominator != 1 or abs(b.numerator) > _MAX_POW:
                raise ValueError("only whole exponents up to 4096 are exact")
            return a ** int(b)
    raise ValueError("only numbers, + - * / // % ** and parentheses are allowed")


def calculate(expr: str) -> str:
    src = (expr or "").replace("×", "*").replace("÷", "/").replace("^", "**").replace(",", "").strip()
    if not src or len(src) > 500:
        raise ValueError("empty or too long expression")
    v = _ev(ast.parse(src, mode="eval"))
    if len(str(v.numerator)) + len(str(v.denominator)) > _MAX_DIGITS:
        raise ValueError("result too large")
    if v.denominator == 1:
        return f"{v.numerator}  (exact)"
    dec = v.numerator / v.denominator
    return f"{v.numerator}/{v.denominator}  = {dec:.12g}  (exact fraction; decimal rounded)"
